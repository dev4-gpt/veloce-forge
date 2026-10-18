import { appendReport } from "@/lib/chainStore";
import { ensureSchema, getTool, review } from "@/lib/db";
import { revokeTool } from "@/lib/audit";
import { runAuditForTool, type AuditOutcome } from "@/lib/auditRun";
import { requireRole } from "@/lib/auth";

export const maxDuration = 120; // an approval is followed by a short fresh-audit sandbox run

// Human review. The approval is bound to the SHA-256 of the exact code the reviewer saw (I4).
//   approve / reject : decide a proposed tool. An approval is followed by a fresh audit (never blocks the approval).
//   revoke           : take an ACTIVE tool out of service; the version it replaced becomes active again (e.g. after a failed audit).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ["reviewer", "admin", "shared"]);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { decision?: string; sha?: string };
  if ((body.decision !== "approve" && body.decision !== "reject" && body.decision !== "revoke") || !body.sha) {
    return Response.json({ error: "decision (approve|reject|revoke) and sha are required" }, { status: 400 });
  }
  await ensureSchema();
  const reviewerId = auth.identity.id === "shared-passcode" ? null : auth.identity.id;
  const r = body.decision === "revoke" ? await revokeTool(id, body.sha, reviewerId) : await review(id, body.decision, body.sha, reviewerId);
  if (!r.ok) return Response.json(r, { status: 409 });
  // Seal the decision into the tamper-evident chain. The decision itself is already committed; a failure to record is reported, not hidden.
  let sealed: { seq: number; hash: string } | { error: string };
  try {
    const tool = await getTool(id);
    const e = await appendReport({
      kind: "decision", toolId: id, family: tool?.family ?? "unknown", decision: body.decision, shaAtDecision: body.sha,
      reviewerId: auth.identity.id, at: new Date().toISOString(),
    });
    sealed = { seq: e.seq, hash: e.hash };
  } catch (err) {
    sealed = { error: err instanceof Error ? err.message : String(err) };
  }
  // Fresh audit after a promotion. Its failure to run is reported, never an undo of the approval.
  let audit: AuditOutcome | { status: "skipped"; reason: string } | undefined;
  if (body.decision === "approve") {
    audit = await runAuditForTool(id).catch((err) => ({ status: "skipped" as const, reason: `the audit could not run: ${err instanceof Error ? err.message : String(err)}` }));
  }
  return Response.json({ ...r, sealed, audit });
}
