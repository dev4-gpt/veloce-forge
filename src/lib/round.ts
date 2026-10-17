// One improvement round: evaluate current tool -> propose -> screen -> score in sandbox -> gate.
// Returns a verdict plus usage for the ledger. Promotion still needs a hash-bound human approval (not here).
import { FAMILIES, type Family, sha256 } from "./bench/cases";
import { decideGate, type GateDecision, type RunnerOutput, scoreOutputs, staticScreen } from "./gate";
import { type Failure, propose } from "./gemini";
import { RUNNER_PY } from "./sandbox/runnerSource";
import { createSandbox, destroySandbox, exec, upload } from "./sandbox/client";

export type RoundEvent = { type: string; [k: string]: unknown };

export interface RoundUsage {
  tokensIn: number | null;
  tokensOut: number | null;
  execMs: number | null;
  unknown: boolean; // true if ANY usage figure was missing -> caller must NOT settle as zero
}

export interface RoundResult {
  verdict: "proposed" | "rejected" | "blocked_unsettled";
  family: Family;
  candidate?: { code: string; sha: string; rationale: string };
  visible: { current: number; candidate: number; total: number };
  heldout: { current: number; candidate: number; total: number };
  gate?: GateDecision;
  heldoutPass?: boolean[]; // per-case pass vector of the candidate (stored with the tool version)
  currentHeldoutPass: boolean[]; // per-case pass vector of the tool being improved
  currentVisibleCount: number;
  usage: RoundUsage;
  attempts: number;
}

async function runInSandbox(sandboxId: string, code: string, inputs: string[]): Promise<{ out: RunnerOutput; execMs: number | null }> {
  await upload(sandboxId, "/workspace/candidate.py", code);
  const r = await exec(sandboxId, "timeout", ["20", "python3", "/workspace/runner.py"], JSON.stringify({ inputs }));
  const last = r.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  try {
    return { out: JSON.parse(last) as RunnerOutput, execMs: r.execMs };
  } catch {
    return { out: { load_error: `runner failed (exit ${r.exitCode}): ${r.stderr.slice(0, 120)}` }, execMs: r.execMs };
  }
}

export async function runRound(opts: {
  family: Family;
  currentCode: string;
  currentHeldoutPass?: boolean[]; // known from when the current version was promoted
  sandboxId?: string; // reuse a session sandbox (free plan allows only one at a time)
  maxAttempts?: number;
  scripted?: { code: string; rationale: string }; // demo-only: a fixed candidate instead of calling the model
  emit?: (e: RoundEvent) => void;
}): Promise<RoundResult> {
  const emit = opts.emit ?? (() => {});
  const spec = FAMILIES[opts.family];
  const maxAttempts = opts.maxAttempts ?? 2;
  const fbCases = [...spec.visible, ...spec.field]; // feedback set: visible + field reports (never held-out)
  const visIn = fbCases.map((c) => c.input);
  const heldIn = spec.heldout.map((c) => c.input);
  const usage: RoundUsage = { tokensIn: 0, tokensOut: 0, execMs: 0, unknown: false };
  const addExec = (ms: number | null) => {
    if (ms === null || usage.execMs === null) {
      usage.execMs = null;
      usage.unknown = true;
    } else usage.execMs += ms;
  };

  let ownSandbox = false;
  let sandboxId = opts.sandboxId;
  try {
    if (!sandboxId) {
      const sb = await createSandbox(`vf-${opts.family.slice(0, 3)}-${Date.now().toString(36)}`);
      sandboxId = sb.id;
      ownSandbox = true;
      emit({ type: "sandbox_created", id: sb.id, spawnMs: sb.spawnMs, egress: ["127.0.0.1"] });
    }
    await upload(sandboxId, "/workspace/runner.py", RUNNER_PY);

    // 1) Evaluate the current tool. Visible failures go to the agent; held-out never does.
    const needHeld = !opts.currentHeldoutPass;
    const cur = await runInSandbox(sandboxId, opts.currentCode, needHeld ? [...visIn, ...heldIn] : visIn);
    addExec(cur.execMs);
    const curVisible = scoreOutputs(fbCases, sliceOut(cur.out, 0, visIn.length));
    const curHeldPass = needHeld ? scoreOutputs(spec.heldout, sliceOut(cur.out, visIn.length, heldIn.length)).pass : opts.currentHeldoutPass!;
    const curHeldCount = curHeldPass.filter(Boolean).length;
    emit({ type: "baseline", visible: curVisible.count, visibleTotal: visIn.length, heldout: curHeldCount, heldoutTotal: heldIn.length });

    const failures: Failure[] = fbCases.flatMap((c, i) =>
      curVisible.pass[i] ? [] : [{ input: c.input, expected: c.expected, got: curVisible.got[i], error: curVisible.errors[i] }],
    );
    emit({ type: "visible_failures", count: failures.length, cases: failures });

    // 2) Propose / screen / score / gate (up to maxAttempts)
    let prior: { code: string; rejectedBecause: string[] } | undefined;
    let last: RoundResult | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const p = opts.scripted
        ? { rationale: opts.scripted.rationale, code: opts.scripted.code, tokensIn: 0, tokensOut: 0, model: "scripted-demo" }
        : await propose({ spec, currentCode: opts.currentCode, failures, priorAttempt: prior });
      if (p.tokensIn === null || p.tokensOut === null || usage.tokensIn === null || usage.tokensOut === null) {
        usage.tokensIn = null;
        usage.tokensOut = null;
        usage.unknown = true;
      } else {
        usage.tokensIn += p.tokensIn;
        usage.tokensOut += p.tokensOut;
      }
      emit({ type: "candidate", attempt, model: p.model, rationale: p.rationale, code: p.code, sha: sha256(p.code) });

      const screen = staticScreen(p.code);
      let candVisible = 0;
      let candHeld: boolean[] = Array(heldIn.length).fill(false);
      if (screen.ok) {
        const r = await runInSandbox(sandboxId, p.code, [...visIn, ...heldIn]);
        addExec(r.execMs);
        candVisible = scoreOutputs(fbCases, sliceOut(r.out, 0, visIn.length)).count;
        candHeld = scoreOutputs(spec.heldout, sliceOut(r.out, visIn.length, heldIn.length)).pass;
      }
      const gate = decideGate({ visibleCount: curVisible.count, heldoutPass: curHeldPass }, { visibleCount: candVisible, heldoutPass: candHeld }, screen);
      const candHeldCount = candHeld.filter(Boolean).length;
      emit({ type: "scores", attempt, visible: candVisible, visibleTotal: visIn.length, heldout: candHeldCount, heldoutTotal: heldIn.length, previousHeldout: curHeldCount });
      emit({ type: "gate", attempt, passed: gate.passed, reasons: gate.reasons });

      last = {
        verdict: gate.passed ? "proposed" : "rejected",
        family: opts.family,
        candidate: { code: p.code, sha: sha256(p.code), rationale: p.rationale },
        visible: { current: curVisible.count, candidate: candVisible, total: visIn.length },
        heldout: { current: curHeldCount, candidate: candHeldCount, total: heldIn.length },
        gate,
        heldoutPass: candHeld,
        currentHeldoutPass: curHeldPass,
        currentVisibleCount: curVisible.count,
        usage,
        attempts: attempt,
      };
      if (gate.passed) break;
      prior = { code: p.code, rejectedBecause: gate.reasons };
    }
    if (usage.unknown && last) {
      last.verdict = "blocked_unsettled"; // unknown usage is never treated as zero cost
      emit({ type: "blocked_unsettled", reason: "a usage figure was missing; reservation stays held" });
    }
    return last!;
  } finally {
    if (ownSandbox && sandboxId) {
      await destroySandbox(sandboxId).catch(() => {});
      emit({ type: "sandbox_destroyed", id: sandboxId });
    }
  }
}

function sliceOut(out: RunnerOutput, start: number, len: number): RunnerOutput {
  if ("outputs" in out) return { outputs: out.outputs.slice(start, start + len) };
  return out;
}
