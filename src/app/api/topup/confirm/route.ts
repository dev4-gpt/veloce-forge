import Stripe from "stripe";
import { credit, ensureSchema, getWallet } from "@/lib/db";


// Called when the browser returns from Checkout. The server asks Stripe (never trusts the browser),
// and credits the wallet at most once per session id.
export async function POST(req: Request) {
  const { session_id } = (await req.json().catch(() => ({}))) as { session_id?: string };
  const key = process.env.STRIPE_SECRET_KEY;
  if (!session_id || !key) return Response.json({ error: "session_id and server key required" }, { status: 400 });
  if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) return Response.json({ error: "non-test key refused" }, { status: 500 });
  const session = await new Stripe(key).checkout.sessions.retrieve(session_id);
  if (session.livemode) return Response.json({ error: "live-mode session refused" }, { status: 400 });
  if (session.payment_status !== "paid") return Response.json({ error: "session not paid" }, { status: 402 });
  await ensureSchema();
  const micros = (session.amount_total ?? 0) * 10_000; // cents -> micro-dollars
  const credited = await credit(`topup:${session.id}`, micros, "Stripe Checkout (test mode)");
  return Response.json({ credited, wallet: await getWallet() });
}
