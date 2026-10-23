// Provider-agnostic JSON completion with ordered fallback, so the agent never depends on a single free tier.
// Order comes from LLM_PROVIDERS (default below). A provider is used only if its key AND model are configured.
// Model ids are never hardcoded here: pick them from each provider's dashboard.
// A transient failure (HTTP 429/500/502/503/504, timeout, dropped connection) is retried on the SAME provider after a short pause
// before the next provider is tried (LLM_RETRY_DELAYS_MS, default "1500,4000"; "0,0" in tests). Other errors fall through at once.
// A TIMEOUT is never retried (it already spent its whole budget), and one completeJSON call has a total time budget
// (LLM_TOTAL_BUDGET_MS, default 100000) across all providers and retries, so a round (two proposals) always finishes inside the
// 300 s function limit. A round killed by that limit leaves its money held and no report, which is what this prevents.
// Free tiers change and may use prompts for training: use only with synthetic or non-sensitive data.
// The OpenAI-compatible endpoints below come from free-LLM directories the author stars (nejib1/Free-LLM,
// open-free-llm-api/awesome-freellm-apis). Those are third-party lists: limits and terms change, so re-check each provider's own page.
// GitHub Models was removed: GitHub's docs report it retired on 2026-07-30 (found in research; re-verify before re-adding).

export interface Completion {
  text: string;
  tokensIn: number | null; // null = provider did not report usage; never treat as zero
  tokensOut: number | null;
  provider: string;
  model: string;
}

interface OpenAICompat {
  name: string;
  baseUrl: string;
  keyEnv: string;
  modelEnv: string;
  extraHeaders?: Record<string, string>;
}

const OPENAI_COMPAT: Record<string, OpenAICompat> = {
  openrouter: { name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", modelEnv: "OPENROUTER_MODEL" },
  nvidia: { name: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1", keyEnv: "NVIDIA_API_KEY", modelEnv: "NVIDIA_MODEL" },
  groq: { name: "groq", baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", modelEnv: "GROQ_MODEL" },
  mistral: { name: "mistral", baseUrl: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY", modelEnv: "MISTRAL_MODEL" },
  cerebras: { name: "cerebras", baseUrl: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY", modelEnv: "CEREBRAS_MODEL" },
  sambanova: { name: "sambanova", baseUrl: "https://api.sambanova.ai/v1", keyEnv: "SAMBANOVA_API_KEY", modelEnv: "SAMBANOVA_MODEL" },
  huggingface: { name: "huggingface", baseUrl: "https://router.huggingface.co/v1", keyEnv: "HUGGINGFACE_API_KEY", modelEnv: "HUGGINGFACE_MODEL" },
  llm7: { name: "llm7", baseUrl: "https://api.llm7.io/v1", keyEnv: "LLM7_API_KEY", modelEnv: "LLM7_MODEL" },
};

export const DEFAULT_ORDER = "gemini,groq,openrouter,nvidia,mistral,cerebras,sambanova,huggingface,llm7";

/** Error that remembers the HTTP status so the retry logic can tell a transient failure from a permanent one. */
export class ProviderError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function isTransient(e: unknown): boolean {
  if (e instanceof ProviderError) return e.status === null || RETRYABLE.has(e.status);
  const name = (e as { name?: string } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return false; // already spent its time: retrying would multiply the wait
  return e instanceof TypeError; // fetch network failures are TypeErrors and fail fast
}

export const RETRY_MIN_REMAINING_MS = 15_000; // do not start a retry or a new provider with less than this left in the budget
export const totalBudgetMs = (env: NodeJS.ProcessEnv = process.env) => {
  const n = Number(env.LLM_TOTAL_BUDGET_MS ?? 100_000);
  return Number.isFinite(n) && n > 0 ? n : 100_000;
};

export function retryDelays(env: NodeJS.ProcessEnv = process.env): number[] {
  const raw = env.LLM_RETRY_DELAYS_MS ?? "1500,4000";
  const d = raw.split(",").map((x) => x.trim()).filter((x) => x !== "").map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  return d.length ? d.slice(0, 4) : [];
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/** Run `fn`, retrying transient failures after each configured delay. A 429 is retried at most once (quota resets are slow). */
export async function withRetry<T>(fn: () => Promise<T>, delays: number[] = retryDelays(), canRetry: () => boolean = () => true): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const limit = e instanceof ProviderError && e.status === 429 ? Math.min(1, delays.length) : delays.length;
      if (attempt >= limit || !isTransient(e) || !canRetry()) throw e;
      await sleep(delays[attempt]);
    }
  }
}

export function configuredProviders(env: NodeJS.ProcessEnv = process.env): string[] {
  const order = (env.LLM_PROVIDERS || DEFAULT_ORDER).split(",").map((s) => s.trim()).filter(Boolean);
  return order.filter((p) => {
    if (p === "gemini") return Boolean(env.GEMINI_API_KEY);
    const c = OPENAI_COMPAT[p];
    return Boolean(c && env[c.keyEnv] && env[c.modelEnv]);
  });
}

async function viaGemini(system: string, user: string, timeoutMs = 90_000): Promise<Completion> {
  const key = process.env.GEMINI_API_KEY!;
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: { rationale: { type: "STRING" }, code: { type: "STRING" } },
          required: ["rationale", "code"],
        },
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(`gemini HTTP ${res.status}: ${String(body?.error?.message ?? "").slice(0, 120)}`, res.status);
  const text = body?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
  const u = body?.usageMetadata;
  return {
    text,
    tokensIn: typeof u?.promptTokenCount === "number" ? u.promptTokenCount : null,
    tokensOut: typeof u?.candidatesTokenCount === "number" ? u.candidatesTokenCount + (u.thoughtsTokenCount ?? 0) : null,
    provider: "gemini",
    model,
  };
}

async function viaOpenAICompat(c: OpenAICompat, system: string, user: string, timeoutMs = 90_000): Promise<Completion> {
  const key = process.env[c.keyEnv]!;
  const model = process.env[c.modelEnv]!;
  const call = (jsonMode: boolean) =>
    fetch(`${c.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...c.extraHeaders },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: system + ' Respond with a single JSON object: {"rationale": string, "code": string}.' },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  let res = await call(true);
  // Some providers or models reject JSON mode; the prompt already demands JSON and extractJson copes with fences, so retry once without it.
  if (res.status === 400 || res.status === 422) res = await call(false);
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(`${c.name} HTTP ${res.status}: ${String(body?.error?.message ?? "").slice(0, 120)}`, res.status);
  const text = body?.choices?.[0]?.message?.content ?? "";
  const u = body?.usage;
  return {
    text,
    tokensIn: typeof u?.prompt_tokens === "number" ? u.prompt_tokens : null,
    tokensOut: typeof u?.completion_tokens === "number" ? u.completion_tokens : null,
    provider: c.name,
    model,
  };
}

function extractJson(text: string): string {
  const t = text.trim();
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : t;
}

/** Try each configured provider in order until one returns parseable JSON with a `code` field. */
export async function completeJSON(system: string, user: string): Promise<{ completion: Completion; json: { rationale?: string; code?: string }; tried: string[] }> {
  const providers = configuredProviders();
  if (providers.length === 0) throw new Error(`no LLM provider configured (set GEMINI_API_KEY, or a key + model for one of: ${Object.keys(OPENAI_COMPAT).join(", ")})`);
  const errors: string[] = [];
  const deadline = Date.now() + totalBudgetMs();
  const remaining = () => deadline - Date.now();
  // each call may use at most what is left of the budget (never more than 90 s, never less than 1 s)
  const callTimeout = () => Math.max(1_000, Math.min(90_000, remaining()));
  for (const p of providers) {
    if (errors.length > 0 && remaining() < RETRY_MIN_REMAINING_MS) {
      errors.push(`${p}: skipped (time budget used up)`);
      break;
    }
    try {
      const completion = await withRetry(
        () => (p === "gemini" ? viaGemini(system, user, callTimeout()) : viaOpenAICompat(OPENAI_COMPAT[p], system, user, callTimeout())),
        retryDelays(),
        () => remaining() >= RETRY_MIN_REMAINING_MS,
      );
      const json = JSON.parse(extractJson(completion.text));
      if (!json.code) throw new Error("no code in response");
      return { completion, json, tried: [...errors.map((e) => e.split(":")[0]), p] };
    } catch (e) {
      errors.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`all providers failed -> ${errors.join(" | ")}`);
}
