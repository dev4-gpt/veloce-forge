import { listHolds, listOpenHolds, reconcileHold, releaseUnresolved, stripeApi } from "@/lib/cardHold";
import { requireRole } from "@/lib/auth";

// Operator view of Stripe test-mode card holds, plus the two safe repair actions.
//   reconcile          : sync a hold with what Stripe says (finishes a capture/release whose outcome was unknown). Never decides money by itself.
//   release_unresolved : a person decides to cancel a parked hold (e.g. a round whose usage was unknown).
export async function GET(req: Request) {
  const auth = await requireRole(req, ["operator", "admin", "reviewer", "shared"]);
  if (auth instanceof Response) return auth;
  const [recent, open] = await Promise.all([listHolds(20), listOpenHolds()]);
  return Response.json({ recent, open }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = await requireRole(req, ["operator", "admin", "shared"]);
  if (auth instanceof Response) return auth;
  const body = (await req.json().catch(() => ({}))) as { action?: string; round?: string };
  if (!body.round || (body.action !== "reconcile" && body.action !== "release_unresolved")) {
    return Response.json({ error: "action (reconcile|release_unresolved) and round are required" }, { status: 400 });
  }
  let api;
  try {
    api = stripeApi();
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
  if (body.action === "reconcile") return Response.json(await reconcileHold(api, body.round));
  const r = await releaseUnresolved(api, body.round);
  return Response.json(r, { status: r.state === "released" ? 200 : 409 });
}
