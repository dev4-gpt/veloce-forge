// Promotion gate. Pure functions so they are unit-testable and cannot be influenced by the agent.
// Principle: the agent proposes; this fixed code scores and decides; a human still has to approve.
import { type Case, equalValue } from "./bench/cases";

export type RunnerOutput =
  | { outputs: ({ ok: unknown } | { err: string })[] }
  | { load_error: string };

export interface Scored {
  pass: boolean[];
  got: unknown[];
  errors: (string | null)[];
  count: number;
}

export function scoreOutputs(cases: Case[], out: RunnerOutput, scorer?: (c: Case, got: unknown) => boolean): Scored {
  const n = cases.length;
  if ("load_error" in out || !("outputs" in out) || out.outputs.length !== n) {
    const msg = "load_error" in out ? out.load_error : "runner returned the wrong number of outputs";
    return { pass: Array(n).fill(false), got: Array(n).fill(null), errors: Array(n).fill(msg), count: 0 };
  }
  const pass: boolean[] = [];
  const got: unknown[] = [];
  const errors: (string | null)[] = [];
  out.outputs.forEach((o, i) => {
    if ("ok" in o) {
      got.push(o.ok);
      errors.push(null);
      pass.push(scorer ? scorer(cases[i], o.ok) : equalValue(o.ok, cases[i].expected));
    } else {
      got.push(null);
      errors.push(o.err);
      pass.push(false);
    }
  });
  return { pass, got, errors, count: pass.filter(Boolean).length };
}

// ---- static screen (defence in depth; the sandbox is the real boundary) ----
const ALLOWED_IMPORTS = new Set([
  "re", "datetime", "math", "decimal", "fractions", "string", "calendar", "unicodedata", "functools", "itertools", "typing", "collections",
]);
// Forbidden builtin calls (not preceded by a dot or word char, so re.compile( is fine) and forbidden module words.
const FORBIDDEN_CALLS = /(^|[^\w.])(open|eval|exec|compile|input|globals|locals|__import__)\s*\(/;
const FORBIDDEN_TOKENS = ["__builtins__", "subprocess", "socket", "urllib", "requests", "importlib", "ctypes", "pickle"];
const FORBIDDEN_WORDS = /\b(os|sys)\./;
const MAX_CODE_CHARS = 8000;

/** The import allowlist for a pillar, as a list (passed to the sandbox runners and the AST screen). */
export function allowedImports(extra: readonly string[] = []): string[] {
  return [...new Set([...ALLOWED_IMPORTS, ...extra])];
}

export interface Screen {
  ok: boolean;
  reasons: string[];
}

export function staticScreen(code: string, extraImports: readonly string[] = []): Screen {
  const allowed = new Set([...ALLOWED_IMPORTS, ...extraImports]);
  const reasons: string[] = [];
  if (code.length > MAX_CODE_CHARS) reasons.push(`code longer than ${MAX_CODE_CHARS} characters`);
  if (!/^\s*def\s+normalize\s*\(/m.test(code)) reasons.push("no top-level def normalize(...)");
  for (const m of code.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w., ]+))/gm)) {
    const mods = (m[1] ? [m[1]] : m[2].split(",")).map((s) => s.trim().split(/\s+as\s+/)[0].split(".")[0]);
    for (const mod of mods) if (mod && !allowed.has(mod)) reasons.push(`import not allowed: ${mod}`);
  }
  const call = code.match(FORBIDDEN_CALLS);
  if (call) reasons.push(`forbidden call: ${call[2]}(`);
  if (FORBIDDEN_WORDS.test(code)) reasons.push("forbidden module use: os./sys.");
  for (const t of FORBIDDEN_TOKENS) if (code.includes(t)) reasons.push(`forbidden token: ${t}`);
  return { ok: reasons.length === 0, reasons };
}

// ---- promotion decision ----
export const HELDOUT_MARGIN = 2; // candidate must beat the current tool by at least this many held-out cases

export interface Standing {
  visibleCount: number;
  heldoutPass: boolean[];
}

export interface GateDecision {
  passed: boolean;
  reasons: string[];
}

export interface CrossCheck {
  currentPass: boolean[]; // sealed end-to-end set with the CURRENT tool of this pillar
  candidatePass: boolean[]; // same set with the CANDIDATE swapped in (partner pillar unchanged)
}

export function decideGate(current: Standing, candidate: Standing, screen: Screen, cross?: CrossCheck): GateDecision {
  const reasons: string[] = [];
  if (!screen.ok) reasons.push(...screen.reasons.map((r) => `static screen: ${r}`));
  const curH = current.heldoutPass.filter(Boolean).length;
  const candH = candidate.heldoutPass.filter(Boolean).length;
  if (candH < curH + HELDOUT_MARGIN) reasons.push(`held-out ${candH} does not beat current ${curH} by ${HELDOUT_MARGIN}`);
  const regressed = current.heldoutPass.flatMap((p, i) => (p && !candidate.heldoutPass[i] ? [i] : []));
  if (regressed.length) reasons.push(`regression on ${regressed.length} held-out case(s) the current tool passed`);
  if (candidate.visibleCount < current.visibleCount) reasons.push("visible score dropped");
  if (cross) {
    const cur = cross.currentPass.filter(Boolean).length;
    const cand = cross.candidatePass.filter(Boolean).length;
    if (cand < cur) reasons.push(`cross-pillar: end-to-end score dropped (${cand} < ${cur})`);
    const broke = cross.currentPass.flatMap((p, i) => (p && !cross.candidatePass[i] ? [i] : []));
    if (broke.length) reasons.push(`cross-pillar: end-to-end regression on ${broke.length} case(s) that passed before`);
  }
  return { passed: reasons.length === 0, reasons };
}

// ---- sandbox egress proof ----
// The probe script prints "REACHED" only if an outbound HTTPS request succeeded. Anything else
// (timeout, DNS failure, connection refused, crash) counts as blocked, which is the safe direction.
export function egressBlocked(exitCode: number, stdout: string): boolean {
  return !(exitCode === 0 && stdout.includes("REACHED"));
}

/** What the model may be told about a rejection. Held-out counts and regression details stay server-side:
 *  repeated queries of aggregate held-out scores would let the proposer overfit to the hidden set. */
export function feedbackSafeReasons(reasons: string[]): string[] {
  const safe = reasons.filter((r) => r.startsWith("static screen:"));
  const hidden = reasons.length - safe.length;
  if (hidden > 0) safe.push("the candidate did not generalise well enough to unseen cases; handle more format variants without hardcoding");
  return safe;
}
