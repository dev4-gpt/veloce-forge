import { appendReport } from "@/lib/chainStore";
import { ensureSchema, getTool, review } from "@/lib/db";
import { requireRole } from "@/lib/auth";


// Human review. The approval is bound to the SHA-256 of the exact code the reviewer saw (I4).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ["reviewer", "admin", "shared"]);
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { decision?: string; sha?: string };
  if ((body.decision !== "approve" && body.decision !== "reject") || !body.sha) {
    return Response.json({ error: "decision (approve|reject) and sha are required" }, { status: 400 });
  }
  await ensureSchema();
  const r = await review(id, body.decision, body.sha, auth.identity.id === "shared-passcode" ? null : auth.identity.id);
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
  return Response.json({ ...r, sealed });
}
