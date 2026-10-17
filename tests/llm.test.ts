// Run: npx tsx --test tests/llm.test.ts
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { completeJSON, configuredProviders } from "../src/lib/llm";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ["LLM_PROVIDERS", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "NVIDIA_API_KEY", "NVIDIA_MODEL"]) delete process.env[k];
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
