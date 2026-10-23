// Runs a fresh audit for a just-promoted tool (see audit.ts for the idea and its limits).
// Same Veloce rules as a round: pay/reserve BEFORE any sandbox exists, prove outbound access is blocked from inside the sandbox
// before running any model-written code, unknown usage is never priced as zero, and the sandbox is always destroyed.
// Nothing here can reject, reverse or promote a tool: it records a result, and a person decides what to do about a failure.
import { FAMILIES, type Family } from "./bench/cases";
import { SCORERS } from "./bench/scorers";
import { appendReport } from "./chainStore";
import { priceMicros } from "./cost";
import { ensureSchema, getHeldoutSet, getTool } from "./db";
import { allowedImports, egressBlocked, type RunnerOutput, scoreOutputs } from "./gate";
import { walletPayer, type Payer } from "./payer";
import { runInSandbox } from "./round";
import { createSandboxReaping, destroySandbox, exec, upload } from "./sandbox/client";
import { RUNNER_PY } from "./sandbox/runnerSource";
import { auditKey, decideAudit, getAudit, previousTool, saveAudit, type AuditRow } from "./audit";
import type { AuditBody } from "./evidence";

export const AUDIT_CAP_MICROS = 50_000; // $0.05 reserved before the audit sandbox exists

/** The sandbox operations an audit needs. Injectable so tests can run the real runner locally without the CreateOS quota. */
export interface AuditSandbox {
  open(name: string): Promise<{ id: string }>;
  probeEgressBlocked(id: string): Promise<{ blocked: boolean; execMs: number | null }>;
  run(id: string, code: string, inputs: string[], allowed: string[]): Promise<{ out: RunnerOutput; execMs: number | null }>;
  close(id: string): Promise<void>;
}

export const realAuditSandbox: AuditSandbox = {
  async open(name) {
    const sb = await createSandboxReaping(name);
    await upload(sb.id, "/workspace/runner.py", RUNNER_PY);
    return { id: sb.id };
  },
  async probeEgressBlocked(id) {
    const p = await exec(id, "timeout", ["8", "python3", "-c", "import urllib.request;urllib.request.urlopen('https://example.com',timeout=4);print('REACHED')"]);
    return { blocked: egressBlocked(p.exitCode, p.stdout), execMs: p.execMs };
  },
  run: (id, code, inputs, allowed) => runInSandbox(id, code, inputs, allowed),
  close: (id) => destroySandbox(id),
};

export type AuditOutcome =
  | { status: "passed" | "failed"; audit: AuditRow; reused: boolean }
  | { status: "skipped"; reason: string };

export interface AuditDeps {
  sandbox?: AuditSandbox;
  payer?: (toolId: string) => Payer;
  record?: (b: AuditBody) => Promise<unknown>;
}

const skipped = (reason: string): AuditOutcome => ({ status: "skipped", reason });

export async function runAuditForTool(toolId: string, deps: AuditDeps = {}): Promise<AuditOutcome> {
  await ensureSchema();
  const sandbox = deps.sandbox ?? realAuditSandbox;
  const tool = await getTool(toolId);
  if (!tool) return skipped("tool not found");
  if (tool.status !== "active") return skipped(`tool is ${tool.status}; only a promoted (active) tool is audited`);
  const family = tool.family as Family;
  const set = await getHeldoutSet(auditKey(family));
  if (!set || set.cases.length < 5) return skipped("no audit set is configured for this family (the tool stays unaudited)");
  const held = await getHeldoutSet(family);
  if (tool.heldout_count === null || !held || held.cases.length === 0) return skipped("the tool's held-out standing is unknown, so the audit cannot compare against it");
  const existing = await getAudit(toolId, set.sha);
  if (existing) return { status: existing.status, audit: existing, reused: true };
  const prev = await previousTool(tool);
  if (!prev) return skipped("there is no earlier version to compare with");

  const payer = deps.payer ? deps.payer(tool.id) : walletPayer(`audit-${tool.id}`, AUDIT_CAP_MICROS);
  const authz = await payer.authorize();
  if (!authz.ok) return skipped(`audit not paid for (${authz.reason}); the tool stays unaudited`);

  const spec = FAMILIES[family];
  const allowed = allowedImports(spec.extraImports);
  const scorer = SCORERS[family];
  const inputs = set.cases.map((c) => c.input);
  let sandboxId: string | null = null;
  let execMs: number | null = 0;
  const add = (ms: number | null) => {
    execMs = ms === null || execMs === null ? null : execMs + ms;
  };
  let candPass: boolean[];
  let prevPass: boolean[];
  try {
    sandboxId = (await sandbox.open(`vf-aud-${Date.now().toString(36)}`)).id;
    const probe = await sandbox.probeEgressBlocked(sandboxId);
    add(probe.execMs);
    if (!probe.blocked) throw new Error("egress is not blocked inside the sandbox; refusing to run code");
    const cand = await sandbox.run(sandboxId, tool.code, inputs, allowed);
    add(cand.execMs);
    const old = await sandbox.run(sandboxId, prev.code, inputs, allowed);
    add(old.execMs);
    candPass = scoreOutputs(set.cases, cand.out, scorer).pass;
    prevPass = scoreOutputs(set.cases, old.out, scorer).pass;
  } catch (e) {
    // The audit could not run. Work began, so usage is unknown: keep the money held and say so. This is not a failed audit.
    await payer.block(`audit failed to run: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`).catch(() => {});
    return skipped(`the audit could not run: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (sandboxId) await sandbox.close(sandboxId).catch(() => {});
  }

  const decision = decideAudit({ prevPass, candPass, heldout: { pass: tool.heldout_count, total: held.cases.length } });
  const settled = await payer.settle(execMs === null ? null : priceMicros({ tokensIn: 0, tokensOut: 0, execMs }));
  const cost = settled.kind === "settled" ? settled.costMicros : null;
  const audit = await saveAudit({
    tool_id: tool.id, set_sha: set.sha, family, status: decision.passed ? "passed" : "failed", cand_pass: candPass, prev_tool_id: prev.id, prev_pass: prevPass,
    heldout_pass: tool.heldout_count, heldout_total: held.cases.length, reasons: decision.reasons, sandbox_id: sandboxId, cost_micros: cost,
  });
  const record = deps.record ?? ((b: AuditBody) => appendReport(b));
  await record({
    kind: "audit", toolId: tool.id, family, auditSetSha: set.sha, candidate: { pass: candPass.filter(Boolean).length, total: candPass.length },
    previous: { toolId: prev.id, pass: prevPass.filter(Boolean).length, total: prevPass.length }, heldout: { pass: tool.heldout_count, total: held.cases.length },
    passed: decision.passed, reasons: decision.reasons, egressBlocked: true, sandboxId, costMicros: cost, at: new Date().toISOString(),
  }).catch(() => {}); // a missing chain entry is visible (no audit entry for an audited tool) but never changes the stored result
  return { status: audit.status, audit, reused: false };
}
