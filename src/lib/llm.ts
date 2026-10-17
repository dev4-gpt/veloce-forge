// Provider-agnostic JSON completion with ordered fallback, so the agent never depends on a single free tier.
// Order comes from LLM_PROVIDERS (default: gemini,openrouter,nvidia,github). A provider is used only if its key AND
// model are configured. Model ids are never hardcoded here: pick them from each provider's dashboard.
// Free tiers change and may use prompts for training: use only with synthetic or non-sensitive data.

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
  github: { name: "github", baseUrl: "https://models.github.ai/inference", keyEnv: "GITHUB_MODELS_TOKEN", modelEnv: "GITHUB_MODELS_MODEL" },
};

export function configuredProviders(env: NodeJS.ProcessEnv = process.env): string[] {
  const order = (env.LLM_PROVIDERS || "gemini,openrouter,nvidia,github").split(",").map((s) => s.trim()).filter(Boolean);
  return order.filter((p) => {
    if (p === "gemini") return Boolean(env.GEMINI_API_KEY);
    const c = OPENAI_COMPAT[p];
    return Boolean(c && env[c.keyEnv] && env[c.modelEnv]);
  });
}

async function viaGemini(system: string, user: string): Promise<Completion> {
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
    signal: AbortSignal.timeout(90_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gemini HTTP ${res.status}: ${String(body?.error?.message ?? "").slice(0, 120)}`);
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

async function viaOpenAICompat(c: OpenAICompat, system: string, user: string): Promise<Completion> {
  const key = process.env[c.keyEnv]!;
  const model = process.env[c.modelEnv]!;
  const res = await fetch(`${c.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...c.extraHeaders },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system + ' Respond with a single JSON object: {"rationale": string, "code": string}.' },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${c.name} HTTP ${res.status}: ${String(body?.error?.message ?? "").slice(0, 120)}`);
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
  if (providers.length === 0) throw new Error("no LLM provider configured (set GEMINI_API_KEY or an OpenRouter/NVIDIA/GitHub key + model)");
  const errors: string[] = [];
  for (const p of providers) {
    try {
      const completion = p === "gemini" ? await viaGemini(system, user) : await viaOpenAICompat(OPENAI_COMPAT[p], system, user);
      const json = JSON.parse(extractJson(completion.text));
      if (!json.code) throw new Error("no code in response");
      return { completion, json, tried: [...errors.map((e) => e.split(":")[0]), p] };
    } catch (e) {
      errors.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`all providers failed -> ${errors.join(" | ")}`);
}
