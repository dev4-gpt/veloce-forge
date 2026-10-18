import { listAudits } from "@/lib/audit";
import { runAuditForTool } from "@/lib/auditRun";
import { requireRole } from "@/lib/auth";

export const maxDuration = 120;

// Audits of promoted tools. GET lists recent results (per-case vectors are never returned). POST runs one for an active tool that
// has none yet (for example when no audit set was configured at approval time, or the wallet was empty).
export async function GET(req: Request) {
  const auth = await requireRole(req, ["operator", "reviewer", "admin", "shared"]);
  if (auth instanceof Response) return auth;
  const rows = await listAudits(30);
  return Response.json({
    audits: rows.map((a) => ({
      tool: a.tool_id, family: a.family, status: a.status, previous: a.prev_tool_id, setCommitment: a.set_sha, reasons: a.reasons, at: a.created_at,
      candidate: { pass: a.cand_pass.filter(Boolean).length, total: a.cand_pass.length }, previousScore: { pass: a.prev_pass.filter(Boolean).length, total: a.prev_pass.length },
      heldout: { pass: a.heldout_pass, total: a.heldout_total },
    })),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = await requireRole(req, ["operator", "reviewer", "admin", "shared"]);
  if (auth instanceof Response) return auth;
  const { tool } = (await req.json().catch(() => ({}))) as { tool?: string };
  if (!tool) return Response.json({ error: "tool is required" }, { status: 400 });
  const out = await runAuditForTool(tool);
  if (out.status === "skipped") return Response.json(out, { status: 409 });
  return Response.json({ status: out.status, reused: out.reused, reasons: out.audit.reasons, candidate: out.audit.cand_pass.filter(Boolean).length, total: out.audit.cand_pass.length });
}
