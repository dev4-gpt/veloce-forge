// LLM proposer (Gemini first, with fallbacks). The model only returns code text; it never runs anything and never sees held-out cases.
import type { FamilySpec } from "./bench/cases";
import { completeJSON } from "./llm";

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
  const parts = [
    `Role: ${opts.spec.agentRole}`,
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

  // Ordered fallback across Gemini, OpenRouter, NVIDIA NIM and GitHub Models (see llm.ts).
  const { completion, json } = await completeJSON(SYSTEM, parts.join("\n\n"));
  return {
    rationale: json.rationale ?? "",
    code: json.code!,
    tokensIn: completion.tokensIn,
    tokensOut: completion.tokensOut,
    model: `${completion.provider}:${completion.model}`,
  };
}
