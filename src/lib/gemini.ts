// Gemini proposer. The model only returns code text; it never runs anything and never sees held-out cases.
import type { FamilySpec } from "./bench/cases";

export interface Failure {
  input: string;
  expected: string | number;
  got: unknown;
  error: string | null;
}

export interface Proposal {
  rationale: string;
  code: string;
  tokensIn: number | null; // null = usage not reported; never treat as zero
  tokensOut: number | null;
  model: string;
}

const SYSTEM =
  "You write one Python 3 module that defines `normalize(raw: str)` using only the standard library (re, datetime, math, decimal, " +
  "fractions, string, calendar, unicodedata, functools, itertools, typing). No file, network, subprocess, eval/exec or os/sys use. " +
  "You are shown failing example cases (input, expected, your output). Generalise: do NOT hardcode the examples; handle the format " +
  "variants a reasonable user would write, following the rules in the task. Return the complete module.";

export async function propose(opts: {
  spec: FamilySpec;
  currentCode: string;
  failures: Failure[];
  priorAttempt?: { code: string; rejectedBecause: string[] };
}): Promise<Proposal> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";

  const parts = [
    `Task: ${opts.spec.instruction}`,
    `Current implementation:\n${opts.currentCode}`,
    `Failing visible cases (JSON):\n${JSON.stringify(opts.failures, null, 1)}`,
  ];
  if (opts.priorAttempt) {
    parts.push(
      `Your previous attempt was rejected by the gate: ${opts.priorAttempt.rejectedBecause.join("; ")}\nPrevious code:\n${opts.priorAttempt.code}`,
    );
  }
  parts.push("Return JSON with keys rationale (one or two sentences) and code (the complete Python module).");

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: parts.join("\n\n") }] }],
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
  if (!res.ok) throw new Error(`Gemini ${model} HTTP ${res.status}: ${String(body?.error?.message ?? "").slice(0, 160)}`);
  const text = body?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
  let parsed: { rationale?: string; code?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Gemini returned non-JSON output");
  }
  if (!parsed.code) throw new Error("Gemini returned no code");
  const u = body?.usageMetadata;
  const tokensIn = typeof u?.promptTokenCount === "number" ? u.promptTokenCount : null;
  const out = typeof u?.candidatesTokenCount === "number" ? u.candidatesTokenCount + (u.thoughtsTokenCount ?? 0) : null;
  return { rationale: parsed.rationale ?? "", code: parsed.code, tokensIn, tokensOut: out, model };
}
