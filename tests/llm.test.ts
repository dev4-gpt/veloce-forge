// Run: npx tsx --test tests/llm.test.ts
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { callCapMs, completeJSON, maxOutputTokens, providerOrder, providerWarnings, resolveCompat, validBaseUrl, configuredProviders, DEFAULT_ORDER, ProviderError, retryDelays, totalBudgetMs, withRetry } from "../src/lib/llm";

const realFetch = globalThis.fetch;
const ENV_KEYS = ["LLM_PROVIDERS", "LLM_RETRY_DELAYS_MS", "LLM_TOTAL_BUDGET_MS", "LLM_CALL_TIMEOUT_MS", "LLM_MAX_OUTPUT_TOKENS", "LLM_TOGETHER_BASE_URL", "LLM_TOGETHER_API_KEY", "LLM_TOGETHER_MODEL", "LLM_MY_HOST_BASE_URL", "LLM_MY_HOST_API_KEY", "LLM_MY_HOST_MODEL", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "NVIDIA_API_KEY", "NVIDIA_MODEL",
  "GROQ_API_KEY", "GROQ_MODEL", "MISTRAL_API_KEY", "MISTRAL_MODEL", "CEREBRAS_API_KEY", "CEREBRAS_MODEL", "SAMBANOVA_API_KEY", "SAMBANOVA_MODEL",
  "HUGGINGFACE_API_KEY", "HUGGINGFACE_MODEL", "LLM7_API_KEY", "LLM7_MODEL"];
beforeEach(() => {
  process.env.LLM_RETRY_DELAYS_MS = "0,0"; // tests never wait; the pause itself is not what is being tested
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) delete process.env[k];
});

test("only providers with BOTH key and model are configured, in the requested order", () => {
  process.env.GEMINI_API_KEY = "g";
  process.env.OPENROUTER_API_KEY = "o"; // no model -> skipped
  process.env.NVIDIA_API_KEY = "n";
  process.env.NVIDIA_MODEL = "m";
  assert.deepEqual(configuredProviders(), ["gemini", "nvidia"]);
  process.env.LLM_PROVIDERS = "nvidia,gemini";
  assert.deepEqual(configuredProviders(), ["nvidia", "gemini"]);
});

test("falls back to the next provider when the first is rate limited", async () => {
  process.env.GEMINI_API_KEY = "g";
  process.env.OPENROUTER_API_KEY = "o";
  process.env.OPENROUTER_MODEL = "some/free-model";
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("generativelanguage")) return new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"rationale":"r","code":"def normalize(raw):\\n    return raw"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      { status: 200 },
    );
  }) as typeof fetch;
  const r = await completeJSON("sys", "user");
  assert.equal(r.completion.provider, "openrouter");
  assert.equal(r.completion.tokensIn, 10);
  assert.deepEqual(r.tried, ["gemini", "openrouter"]);
});

test("missing usage is reported as null, never zero", async () => {
  process.env.OPENROUTER_API_KEY = "o";
  process.env.OPENROUTER_MODEL = "x";
  process.env.LLM_PROVIDERS = "openrouter";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"rationale":"r","code":"def normalize(raw):\\n    return raw"}\n```' } }] }), { status: 200 })) as typeof fetch;
  const r = await completeJSON("s", "u");
  assert.equal(r.completion.tokensIn, null);
  assert.equal(r.completion.tokensOut, null);
});

test("errors clearly when every provider fails or none is configured", async () => {
  await assert.rejects(() => completeJSON("s", "u"), /no LLM provider configured/);
  process.env.OPENROUTER_API_KEY = "o";
  process.env.OPENROUTER_MODEL = "x";
  process.env.LLM_PROVIDERS = "openrouter";
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  await assert.rejects(() => completeJSON("s", "u"), /all providers failed/);
});

// ---------- retry on transient failures ----------
const okGemini = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"rationale":"r","code":"def normalize(raw):\\n    return raw"}' }] } }] }), { status: 200 });
const okChat = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"rationale":"r","code":"def normalize(raw):\\n    return raw"}' } }] }), { status: 200 });
const counter = (h: (url: string, call: number, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: { url: string; body: string }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return h(String(url), calls.length, init);
  }) as typeof fetch;
  return calls;
};

test("a transient 503 is retried on the same provider and then succeeds", async () => {
  process.env.GEMINI_API_KEY = "g";
  const calls = counter((_u, n) => (n === 1 ? new Response(JSON.stringify({ error: { message: "high demand" } }), { status: 503 }) : okGemini()));
  const r = await completeJSON("s", "u");
  assert.equal(r.completion.provider, "gemini");
  assert.equal(calls.length, 2);
  assert.deepEqual(r.tried, ["gemini"]);
});

test("a persistent 503 is retried twice (three calls) before the next provider is used", async () => {
  process.env.GEMINI_API_KEY = "g";
  process.env.GROQ_API_KEY = "k";
  process.env.GROQ_MODEL = "m";
  const calls = counter((u) => (u.includes("generativelanguage") ? new Response("{}", { status: 503 }) : okChat()));
  const r = await completeJSON("s", "u");
  assert.equal(r.completion.provider, "groq");
  assert.equal(calls.filter((c) => c.url.includes("generativelanguage")).length, 3);
  assert.equal(calls.filter((c) => c.url.includes("api.groq.com/openai/v1")).length, 1);
});

test("a 429 is retried at most once, because quota resets are slow", async () => {
  process.env.GEMINI_API_KEY = "g";
  process.env.GROQ_API_KEY = "k";
  process.env.GROQ_MODEL = "m";
  const calls = counter((u) => (u.includes("generativelanguage") ? new Response("{}", { status: 429 }) : okChat()));
  await completeJSON("s", "u");
  assert.equal(calls.filter((c) => c.url.includes("generativelanguage")).length, 2);
});

test("a permanent error (401) is not retried: the next provider is tried at once", async () => {
  process.env.GEMINI_API_KEY = "bad";
  process.env.GROQ_API_KEY = "k";
  process.env.GROQ_MODEL = "m";
  const calls = counter((u) => (u.includes("generativelanguage") ? new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 401 }) : okChat()));
  const r = await completeJSON("s", "u");
  assert.equal(r.completion.provider, "groq");
  assert.equal(calls.filter((c) => c.url.includes("generativelanguage")).length, 1);
});

test("a dropped connection (fetch TypeError) is treated as transient and retried", async () => {
  process.env.GEMINI_API_KEY = "g";
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    if (n === 1) throw new TypeError("fetch failed");
    return okGemini();
  }) as typeof fetch;
  const r = await completeJSON("s", "u");
  assert.equal(r.completion.provider, "gemini");
  assert.equal(n, 2);
});

test("withRetry honours the delays list, retries only transient errors, and rethrows the last error", async () => {
  let calls = 0;
  await assert.rejects(() => withRetry(async () => { calls++; throw new ProviderError("x HTTP 503", 503); }, [0, 0, 0]), /503/);
  assert.equal(calls, 4); // first try + 3 retries
  calls = 0;
  await assert.rejects(() => withRetry(async () => { calls++; throw new ProviderError("x HTTP 400", 400); }, [0, 0]), /400/);
  assert.equal(calls, 1);
  calls = 0;
  assert.equal(await withRetry(async () => { calls++; if (calls < 3) throw new ProviderError("x HTTP 502", 502); return "ok"; }, [0, 0]), "ok");
  assert.equal(calls, 3);
});

test("retry delays come from LLM_RETRY_DELAYS_MS, ignore junk, cap at four, and an empty list disables retries", () => {
  assert.deepEqual(retryDelays({} as NodeJS.ProcessEnv), [1500, 4000]);
  assert.deepEqual(retryDelays({ LLM_RETRY_DELAYS_MS: "10, 20,x,-5,30,40,50" } as unknown as NodeJS.ProcessEnv), [10, 20, 30, 40]);
  assert.deepEqual(retryDelays({ LLM_RETRY_DELAYS_MS: "" } as unknown as NodeJS.ProcessEnv), []);
});

// ---------- JSON mode fallback ----------
test("a provider that rejects JSON mode gets one retry without response_format", async () => {
  process.env.GROQ_API_KEY = "k";
  process.env.GROQ_MODEL = "m";
  process.env.LLM_PROVIDERS = "groq";
  const calls = counter((_u, n) => (n === 1 ? new Response(JSON.stringify({ error: { message: "response_format unsupported" } }), { status: 400 }) : okChat()));
  const r = await completeJSON("s", "u");
  assert.equal(r.completion.provider, "groq");
  assert.equal(calls.length, 2);
  assert.ok(JSON.parse(calls[0].body).response_format);
  assert.equal(JSON.parse(calls[1].body).response_format, undefined);
});

// ---------- the wider provider list ----------
test("each free OpenAI-compatible provider needs BOTH its key and model, uses its own endpoint, and is in the default order", async () => {
  const table: [string, string, string][] = [
    ["groq", "GROQ", "https://api.groq.com/openai/v1/chat/completions"],
    ["mistral", "MISTRAL", "https://api.mistral.ai/v1/chat/completions"],
    ["cerebras", "CEREBRAS", "https://api.cerebras.ai/v1/chat/completions"],
    ["sambanova", "SAMBANOVA", "https://api.sambanova.ai/v1/chat/completions"],
    ["huggingface", "HUGGINGFACE", "https://router.huggingface.co/v1/chat/completions"],
    ["llm7", "LLM7", "https://api.llm7.io/v1/chat/completions"],
  ];
  for (const [name, prefix, url] of table) {
    assert.ok(DEFAULT_ORDER.split(",").includes(name), `${name} missing from the default order`);
    process.env[`${prefix}_API_KEY`] = "k";
    assert.equal(configuredProviders().includes(name), false, `${name} must not be configured without a model`);
    process.env[`${prefix}_MODEL`] = "some-model";
    assert.equal(configuredProviders().includes(name), true);
    process.env.LLM_PROVIDERS = name;
    const calls = counter(() => okChat());
    const r = await completeJSON("s", "u");
    assert.equal(r.completion.provider, name);
    assert.equal(calls[0].url, url);
    assert.equal(JSON.parse(calls[0].body).model, "some-model");
    delete process.env[`${prefix}_API_KEY`];
    delete process.env[`${prefix}_MODEL`];
    delete process.env.LLM_PROVIDERS;
  }
});

test("an unknown provider name in LLM_PROVIDERS is ignored rather than crashing", () => {
  process.env.GEMINI_API_KEY = "g";
  process.env.LLM_PROVIDERS = "nonsense,gemini";
  assert.deepEqual(configuredProviders(), ["gemini"]);
});

test("the error when nothing is configured names the supported providers", async () => {
  await assert.rejects(() => completeJSON("s", "u"), /groq.*mistral.*cerebras/);
});

// ---------- time budget: a round must finish inside the 300 s function limit ----------
const hang = (init?: RequestInit) =>
  new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)));

test("a provider that hangs until its timeout is NOT retried (a retry would multiply the wait)", async () => {
  process.env.GEMINI_API_KEY = "g";
  process.env.LLM_TOTAL_BUDGET_MS = "1200";
  const calls = counter((_u, _n, init) => hang(init) as unknown as Response);
  const t0 = Date.now();
  await assert.rejects(() => completeJSON("s", "u"), /all providers failed/);
  assert.equal(calls.length, 1);
  assert.ok(Date.now() - t0 < 4000, "must give up after about one call timeout, not several");
});

test("each call's timeout is capped by what is left of the total budget", async () => {
  process.env.GEMINI_API_KEY = "g";
  process.env.LLM_TOTAL_BUDGET_MS = "1500";
  const t0 = Date.now();
  counter((_u, _n, init) => hang(init) as unknown as Response);
  await assert.rejects(() => completeJSON("s", "u"));
  const took = Date.now() - t0;
  assert.ok(took >= 1000 && took < 3000, `took ${took} ms; the 90 s default must not apply`);
});

test("with the budget nearly used up, no further provider is started and no retry is made", async () => {
  process.env.GEMINI_API_KEY = "g";
  process.env.GROQ_API_KEY = "k";
  process.env.GROQ_MODEL = "m";
  process.env.LLM_TOTAL_BUDGET_MS = "14000"; // below the 15 s needed to start anything else
  const calls = counter((u) => (u.includes("generativelanguage") ? new Response("{}", { status: 503 }) : okChat()));
  await assert.rejects(() => completeJSON("s", "u"), /time budget used up/);
  assert.equal(calls.length, 1); // one Gemini call: no retry, and Groq never started
});

test("budget parsing: default 100 s, junk and non-positive values fall back to the default", () => {
  assert.equal(totalBudgetMs({} as NodeJS.ProcessEnv), 100_000);
  assert.equal(totalBudgetMs({ LLM_TOTAL_BUDGET_MS: "30000" } as unknown as NodeJS.ProcessEnv), 30_000);
  assert.equal(totalBudgetMs({ LLM_TOTAL_BUDGET_MS: "abc" } as unknown as NodeJS.ProcessEnv), 100_000);
  assert.equal(totalBudgetMs({ LLM_TOTAL_BUDGET_MS: "0" } as unknown as NodeJS.ProcessEnv), 100_000);
});

test("withRetry stops retrying when canRetry says the budget is gone", async () => {
  let calls = 0;
  await assert.rejects(() => withRetry(async () => { calls++; throw new ProviderError("x HTTP 503", 503); }, [0, 0, 0], () => calls < 2), /503/);
  assert.equal(calls, 2);
});

test("an error named TimeoutError or AbortError is never retried, even if the runtime wraps it as a TypeError", async () => {
  for (const name of ["TimeoutError", "AbortError"]) {
    let calls = 0;
    await assert.rejects(() => withRetry(async () => { calls++; throw Object.assign(new TypeError("t"), { name }); }, [0, 0, 0]));
    assert.equal(calls, 1, name);
  }
});

test("a hung first provider cannot starve the fallback: it is cut off at the per-call cap and the next provider gets a full turn", async () => {
  process.env.GEMINI_API_KEY = "g";
  process.env.GROQ_API_KEY = "k";
  process.env.GROQ_MODEL = "m";
  process.env.LLM_CALL_TIMEOUT_MS = "1000";
  process.env.LLM_TOTAL_BUDGET_MS = "60000";
  const calls = counter((u, _n, init) => (u.includes("generativelanguage") ? (hang(init) as unknown as Response) : okChat()));
  const t0 = Date.now();
  const r = await completeJSON("s", "u");
  assert.equal(r.completion.provider, "groq");
  assert.equal(calls.filter((c) => c.url.includes("generativelanguage")).length, 1); // hang is not retried
  assert.ok(Date.now() - t0 < 5000);
});

test("per-call cap parsing: default 45 s, junk and non-positive values fall back", () => {
  assert.equal(callCapMs({} as NodeJS.ProcessEnv), 45_000);
  assert.equal(callCapMs({ LLM_CALL_TIMEOUT_MS: "20000" } as unknown as NodeJS.ProcessEnv), 20_000);
  assert.equal(callCapMs({ LLM_CALL_TIMEOUT_MS: "x" } as unknown as NodeJS.ProcessEnv), 45_000);
  assert.equal(callCapMs({ LLM_CALL_TIMEOUT_MS: "-1" } as unknown as NodeJS.ProcessEnv), 45_000);
});

// ---------- truncated / malformed replies (seen live: a Groq reply cut off inside the code string) ----------
const chat = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
const GOOD = '{"rationale":"r","code":"def normalize(raw):\\n    return raw"}';

test("a truncated reply (unparseable JSON) is retried on the same provider, then succeeds", async () => {
  process.env.GROQ_API_KEY = "k";
  process.env.GROQ_MODEL = "m";
  process.env.LLM_PROVIDERS = "groq";
  const calls = counter((_u, n) => (n === 1 ? chat('{"rationale":"r","code":"def normalize(raw):\\n    return ra') : chat(GOOD)));
  const r = await completeJSON("s", "u");
  assert.equal(r.completion.provider, "groq");
  assert.equal(calls.length, 2);
});

test("a reply that stays unparseable falls through to the next provider after the retries", async () => {
  process.env.GROQ_API_KEY = "k";
  process.env.GROQ_MODEL = "m";
  process.env.MISTRAL_API_KEY = "k";
  process.env.MISTRAL_MODEL = "m";
  process.env.LLM_PROVIDERS = "groq,mistral";
  const calls = counter((u) => (u.includes("groq") ? chat("{not json") : chat(GOOD)));
  const r = await completeJSON("s", "u");
  assert.equal(r.completion.provider, "mistral");
  assert.equal(calls.filter((c) => c.url.includes("groq")).length, 3); // first try + 2 retries
});

test("a reply without code is also retried, and the final error says why", async () => {
  process.env.GROQ_API_KEY = "k";
  process.env.GROQ_MODEL = "m";
  process.env.LLM_PROVIDERS = "groq";
  const calls = counter(() => chat('{"rationale":"only a rationale"}'));
  await assert.rejects(() => completeJSON("s", "u"), /groq reply had no code/);
  assert.equal(calls.length, 3);
});

test("every provider is asked for a large output budget so reasoning models do not truncate the code", async () => {
  process.env.GEMINI_API_KEY = "g";
  process.env.GROQ_API_KEY = "k";
  process.env.GROQ_MODEL = "m";
  const calls = counter((u) => (u.includes("generativelanguage") ? new Response("{}", { status: 401 }) : chat(GOOD)));
  await completeJSON("s", "u");
  assert.equal(JSON.parse(calls.find((c) => c.url.includes("generativelanguage"))!.body).generationConfig.maxOutputTokens, 8192);
  assert.equal(JSON.parse(calls.find((c) => c.url.includes("groq"))!.body).max_tokens, 8192);
  process.env.LLM_MAX_OUTPUT_TOKENS = "4000";
  const c2 = counter(() => chat(GOOD));
  process.env.LLM_PROVIDERS = "groq";
  await completeJSON("s", "u");
  assert.equal(JSON.parse(c2[0].body).max_tokens, 4000);
});

test("output budget parsing: default 8192; junk, tiny and fractional values fall back", () => {
  assert.equal(maxOutputTokens({} as NodeJS.ProcessEnv), 8192);
  assert.equal(maxOutputTokens({ LLM_MAX_OUTPUT_TOKENS: "16000" } as unknown as NodeJS.ProcessEnv), 16000);
  for (const bad of ["abc", "10", "-5", "1000.5", ""]) assert.equal(maxOutputTokens({ LLM_MAX_OUTPUT_TOKENS: bad } as unknown as NodeJS.ProcessEnv), 8192, bad);
});

// ---------- provider warnings and custom providers ----------
const E = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

test("a clean configuration has no warnings", () => {
  assert.deepEqual(providerWarnings(E({ LLM_PROVIDERS: "groq,gemini", GEMINI_API_KEY: "g", GROQ_API_KEY: "k", GROQ_MODEL: "m" })), []);
});

test("a misspelled provider name is reported with a 'did you mean' and how to add a custom one (the grok-for-groq typo)", () => {
  const w = providerWarnings(E({ LLM_PROVIDERS: "grok,gemini", GEMINI_API_KEY: "g", GROQ_API_KEY: "k", GROQ_MODEL: "m" }));
  const text = w.join(" | ");
  assert.match(text, /"grok" in LLM_PROVIDERS is not a known provider, so it is ignored\. Did you mean "groq"\?/);
  assert.match(text, /LLM_GROK_BASE_URL, LLM_GROK_API_KEY and LLM_GROK_MODEL/);
  assert.match(text, /GROQ_API_KEY and GROQ_MODEL are set but "groq" is not in LLM_PROVIDERS/); // the real provider is configured but unused
});

test("a name far from every known provider gets no suggestion", () => {
  const text = providerWarnings(E({ LLM_PROVIDERS: "zzzzzz,gemini", GEMINI_API_KEY: "g" })).join(" | ");
  assert.match(text, /"zzzzzz" in LLM_PROVIDERS is not a known provider/);
  assert.doesNotMatch(text, /Did you mean/);
});

test("a listed provider missing its key or model, or gemini without a key, is reported; nothing usable is reported", () => {
  const a = providerWarnings(E({ LLM_PROVIDERS: "groq,gemini", GEMINI_API_KEY: "g", GROQ_API_KEY: "k" })).join(" | ");
  assert.match(a, /"groq" is listed in LLM_PROVIDERS but GROQ_MODEL is not set/);
  const b = providerWarnings(E({ LLM_PROVIDERS: "groq", })).join(" | ");
  assert.match(b, /GROQ_API_KEY and GROQ_MODEL are not set/);
  assert.match(providerWarnings(E({ LLM_PROVIDERS: "gemini" })).join(" | "), /GEMINI_API_KEY is not set/);
  assert.match(providerWarnings(E({})).join(" | "), /No usable model provider is configured/);
});

test("without an explicit list, configured providers are not reported as unused", () => {
  assert.deepEqual(providerWarnings(E({ GEMINI_API_KEY: "g", GROQ_API_KEY: "k", GROQ_MODEL: "m" })), []);
});

test("names are case-insensitive and trimmed: ' Groq , GEMINI ' works like 'groq,gemini'", () => {
  assert.deepEqual(providerOrder(E({ LLM_PROVIDERS: " Groq , GEMINI " })), ["groq", "gemini"]);
  assert.deepEqual(configuredProviders(E({ LLM_PROVIDERS: " Groq , GEMINI ", GEMINI_API_KEY: "g", GROQ_API_KEY: "k", GROQ_MODEL: "m" })), ["groq", "gemini"]);
});

test("a CUSTOM OpenAI-compatible provider is added with three variables and the name in LLM_PROVIDERS", async () => {
  process.env.LLM_PROVIDERS = "together";
  process.env.LLM_TOGETHER_BASE_URL = "https://api.example-llm.test/v1///";
  process.env.LLM_TOGETHER_API_KEY = "secret-k";
  process.env.LLM_TOGETHER_MODEL = "some-model";
  assert.deepEqual(configuredProviders(), ["together"]);
  assert.deepEqual(providerWarnings(), []);
  const calls = counter(() => okChat());
  const r = await completeJSON("s", "u");
  assert.equal(r.completion.provider, "together");
  assert.equal(calls[0].url, "https://api.example-llm.test/v1/chat/completions"); // trailing slashes tidied
  assert.equal(JSON.parse(calls[0].body).model, "some-model");
});

test("custom provider names with a dash or underscore map to LLM_<NAME> with underscores", () => {
  const env = E({ LLM_PROVIDERS: "my-host", LLM_MY_HOST_BASE_URL: "https://x.test/v1", LLM_MY_HOST_API_KEY: "k", LLM_MY_HOST_MODEL: "m" });
  assert.deepEqual(configuredProviders(env), ["my-host"]);
  assert.equal(resolveCompat("my-host", env)!.keyEnv, "LLM_MY_HOST_API_KEY");
});

test("a custom provider needs its key and model too, and the warning names the missing variable", () => {
  const w = providerWarnings(E({ LLM_PROVIDERS: "together", LLM_TOGETHER_BASE_URL: "https://x.test/v1", LLM_TOGETHER_API_KEY: "k" })).join(" | ");
  assert.match(w, /LLM_TOGETHER_MODEL is not set/);
});

test("a custom base URL must be plain https with no embedded login, or the provider is refused and the key is never sent", async () => {
  for (const bad of ["http://x.test/v1", "https://user:pw@x.test/v1", "ftp://x.test", "not a url", "https://", ""]) {
    assert.equal(validBaseUrl(bad), false, bad);
  }
  assert.equal(validBaseUrl("https://x.test/v1"), true);
  const env = E({ LLM_PROVIDERS: "together", LLM_TOGETHER_BASE_URL: "http://x.test/v1", LLM_TOGETHER_API_KEY: "k", LLM_TOGETHER_MODEL: "m" });
  assert.deepEqual(configuredProviders(env), []);
  assert.match(providerWarnings(env).join(" | "), /LLM_TOGETHER_BASE_URL must be an https:\/\/ address/);
  const calls = counter(() => okChat());
  Object.assign(process.env, env);
  await assert.rejects(() => completeJSON("s", "u"), /no LLM provider configured/);
  assert.equal(calls.length, 0);
});

test("a custom provider cannot replace a built-in name or gemini, and invalid names are rejected", () => {
  const env = E({ LLM_PROVIDERS: "groq,gemini,bad name!", LLM_GROQ_BASE_URL: "https://evil.test/v1", LLM_GEMINI_BASE_URL: "https://evil.test/v1", GROQ_API_KEY: "k", GROQ_MODEL: "m", GEMINI_API_KEY: "g" });
  assert.equal(resolveCompat("groq", env)!.baseUrl, "https://api.groq.com/openai/v1"); // the built-in endpoint wins
  assert.equal(resolveCompat("gemini", env), null);
  assert.match(providerWarnings(env).join(" | "), /"bad name!" in LLM_PROVIDERS is not a valid provider name/);
});
