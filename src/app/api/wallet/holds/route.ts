import { ensureSchema, listStuckHolds, releaseStuckHold } from "@/lib/db";
import { requireRole } from "@/lib/auth";

// Wallet holds that were never settled or released (a failed round with unknown usage, or one the platform killed).
// GET lists them. POST {round} gives ONE back (a person's decision, recorded in the ledger as operator_release:<round>);
// POST {all:true} gives every listed one back. A round that is still running or already settled is refused.
export async function GET(req: Request) {
  const auth = await requireRole(req, ["operator", "admin", "reviewer", "shared"]);
  if (auth instanceof Response) return auth;
  await ensureSchema();
  return Response.json({ stuck: await listStuckHolds() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = await requireRole(req, ["operator", "admin", "shared"]);
  if (auth instanceof Response) return auth;
  const body = (await req.json().catch(() => ({}))) as { round?: string; all?: boolean };
  await ensureSchema();
  const rounds = body.all ? (await listStuckHolds()).map((h) => h.round_id) : body.round ? [body.round] : [];
  if (rounds.length === 0) return Response.json({ error: "round or all:true is required (or nothing is stuck)" }, { status: 400 });
  const results = [];
  for (const r of rounds) results.push({ round: r, ...(await releaseStuckHold(r, auth.identity.name)) });
  return Response.json({ results }, { status: results.every((x) => x.ok) ? 200 : 409 });
}
