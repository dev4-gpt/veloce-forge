// Fresh-audit check: a FROZEN private set that never takes part in any promotion decision. After a human approves a tool, it is
// scored once against the version it replaced. Held-out sets are used to choose between candidates, so a promoted tool's
// held-out score is biased upward (it is the winner of a selection). The audit set has had no selection pressure, so it estimates
// how the tool really performs, and a large gap between the two is the signature of overfitting to the held-out set.
//
// An audit never blocks or reverses anything by itself. A failed audit is recorded (database + hash chain) and shown, and a
// reviewer may revoke the tool: the previous version becomes active again in one statement.
// Limit, stated plainly: every audit still reveals a little about the set to whoever reads the results, so the set should be
// refreshed from time to time (a new set has a new commitment hash and is audited separately).
import { auditCountsOk } from "./evidence";
import { ensureSchema, getTool, sql, type ToolRow } from "./db";
import type { Family } from "./bench/cases";

export const auditKey = (family: Family) => `audit:${family}` as const;

export interface AuditDecision {
  passed: boolean;
  reasons: string[];
}

/** Decide an audit from per-case results of the promoted tool and of the version it replaced on the SAME audit cases. */
export function decideAudit(input: { prevPass: boolean[]; candPass: boolean[]; heldout: { pass: number; total: number } }): AuditDecision {
  const { prevPass, candPass, heldout } = input;
  const reasons: string[] = [];
  if (candPass.length === 0 || candPass.length !== prevPass.length) {
    return { passed: false, reasons: ["audit results are inconsistent (fail closed)"] };
  }
  const cand = { pass: candPass.filter(Boolean).length, total: candPass.length };
  const prev = { pass: prevPass.filter(Boolean).length, total: prevPass.length };
  if (cand.pass < prev.pass) reasons.push(`audit score dropped: ${cand.pass}/${cand.total} vs ${prev.pass}/${prev.total} for the version it replaced`);
  const regressed = prevPass.filter((p, i) => p && !candPass[i]).length;
  if (regressed > 0) reasons.push(`regression on ${regressed} audit case(s) the previous version passed`);
  if (!auditCountsOk(heldout, cand, prev) && reasons.length === 0) {
    reasons.push(`held-out ${heldout.pass}/${heldout.total} is far above the unseen audit ${cand.pass}/${cand.total}: likely overfit to the held-out set`);
  }
  return { passed: reasons.length === 0, reasons };
}

// ---------- storage ----------
export interface AuditRow {
  tool_id: string;
  set_sha: string;
  family: string;
  status: "passed" | "failed";
  cand_pass: boolean[];
  prev_tool_id: string;
  prev_pass: boolean[];
  heldout_pass: number;
  heldout_total: number;
  reasons: string[];
  sandbox_id: string | null;
  cost_micros: number | null;
  created_at: string;
}

const toAudit = (r: any): AuditRow => ({
  tool_id: r.tool_id, set_sha: r.set_sha, family: r.family, status: r.status, cand_pass: JSON.parse(r.cand_pass_json), prev_tool_id: r.prev_tool_id,
  prev_pass: JSON.parse(r.prev_pass_json), heldout_pass: Number(r.heldout_pass), heldout_total: Number(r.heldout_total), reasons: JSON.parse(r.reasons_json),
  sandbox_id: r.sandbox_id, cost_micros: r.cost_micros === null ? null : Number(r.cost_micros), created_at: String(r.created_at),
});

export async function getAudit(toolId: string, setSha: string): Promise<AuditRow | null> {
  await ensureSchema();
  const r = (await sql()`select * from audits where tool_id = ${toolId} and set_sha = ${setSha}`) as any[];
  return r[0] ? toAudit(r[0]) : null;
}

export async function latestAuditFor(toolId: string): Promise<AuditRow | null> {
  await ensureSchema();
  const r = (await sql()`select * from audits where tool_id = ${toolId} order by created_at desc limit 1`) as any[];
  return r[0] ? toAudit(r[0]) : null;
}

export async function listAudits(n = 30): Promise<AuditRow[]> {
  await ensureSchema();
  return ((await sql()`select * from audits order by created_at desc limit ${n}`) as any[]).map(toAudit);
}

/** Store an audit result. Idempotent per (tool, set): a second insert is ignored and the stored row is returned. */
export async function saveAudit(a: Omit<AuditRow, "created_at">): Promise<AuditRow> {
  await ensureSchema();
  await sql()`insert into audits(tool_id, set_sha, family, status, cand_pass_json, prev_tool_id, prev_pass_json, heldout_pass, heldout_total, reasons_json, sandbox_id, cost_micros)
    values (${a.tool_id}, ${a.set_sha}, ${a.family}, ${a.status}, ${JSON.stringify(a.cand_pass)}, ${a.prev_tool_id}, ${JSON.stringify(a.prev_pass)}, ${a.heldout_pass}, ${a.heldout_total}, ${JSON.stringify(a.reasons)}, ${a.sandbox_id}, ${a.cost_micros})
    on conflict (tool_id, set_sha) do nothing`;
  return (await getAudit(a.tool_id, a.set_sha))!;
}

/** The version a promoted tool replaced: the newest superseded version of the family below it (revoked ones are skipped). */
export async function previousTool(tool: ToolRow): Promise<ToolRow | null> {
  await ensureSchema();
  const r = (await sql()`select id from tools where family = ${tool.family} and status = 'superseded' and version < ${tool.version} order by version desc limit 1`) as { id: string }[];
  return r[0] ? getTool(r[0].id) : null;
}

// ---------- revoke ----------
/** A reviewer takes an ACTIVE tool out of service and the version it replaced becomes active again, in ONE statement so there is
 *  never a moment without an active tool. Bound to the code hash the reviewer saw, like approval. */
export async function revokeTool(toolId: string, shaReviewed: string, reviewerId: string | null): Promise<{ ok: boolean; error?: string; restored?: string }> {
  await ensureSchema();
  const t = await getTool(toolId);
  if (!t) return { ok: false, error: "tool not found" };
  if (t.status !== "active") return { ok: false, error: `tool is ${t.status}, not active` };
  if (t.sha !== shaReviewed) return { ok: false, error: "hash mismatch: the code changed after review" };
  const prev = await previousTool(t);
  if (!prev) return { ok: false, error: "there is no earlier version to restore; refusing to leave the family without an active tool" };
  const done = await applyRevoke(toolId, shaReviewed, prev.id, reviewerId);
  return done ? { ok: true, restored: prev.id } : { ok: false, error: "tool changed state during revoke" };
}

/** The single statement behind revoke (see applyReview in db.ts). Exported for tests. True only for the call that really revoked. */
export async function applyRevoke(toolId: string, shaReviewed: string, prevId: string, reviewerId: string | null): Promise<boolean> {
  // The UPDATE is the gate (see review() in db.ts): only the request that really flips the tool out of 'active' records the revoke, so a
  // double submit cannot write two, and the tool is never revoked unless the version it replaced can be restored in the same statement.
  const r = (await sql()`
    with rv as (
      update tools set status = 'revoked'
      where id = ${toolId} and status = 'active' and sha = ${shaReviewed}
        and exists (select 1 from tools p where p.id = ${prevId} and p.status = 'superseded')
      returning id, family),
    prv as (select id from tools where id = ${prevId} and status = 'superseded' and exists (select 1 from rv)),
    appr as (insert into approvals(tool_id, decision, sha_at_decision, reviewer_id) select id, 'revoke'::text, ${shaReviewed}::text, ${reviewerId}::text from rv returning 1),
    rs as (update tools set status = 'active' where id in (select id from prv) returning 1)
    select (select count(*) from rv) as n, (select count(*) from prv) as p`) as { n: number; p: number }[];
  return Number(r[0]?.n ?? 0) > 0 && Number(r[0]?.p ?? 0) > 0;
}
