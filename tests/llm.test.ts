// Run: npx tsx --test tests/llm.test.ts
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { completeJSON, configuredProviders, DEFAULT_ORDER, ProviderError, retryDelays, withRetry } from "../src/lib/llm";

const realFetch = globalThis.fetch;
const ENV_KEYS = ["LLM_PROVIDERS", "LLM_RETRY_DELAYS_MS", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "NVIDIA_API_KEY", "NVIDIA_MODEL",
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
