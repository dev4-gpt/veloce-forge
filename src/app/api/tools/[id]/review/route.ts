import { ensureSchema, review } from "@/lib/db";
import { requirePasscode } from "@/lib/auth";


// Human review. The approval is bound to the SHA-256 of the exact code the reviewer saw (I4).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requirePasscode(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { decision?: string; sha?: string };
  if ((body.decision !== "approve" && body.decision !== "reject") || !body.sha) {
    return Response.json({ error: "decision (approve|reject) and sha are required" }, { status: 400 });
  }
  await ensureSchema();
  const r = await review(id, body.decision, body.sha);
  return Response.json(r, { status: r.ok ? 200 : 409 });
}
