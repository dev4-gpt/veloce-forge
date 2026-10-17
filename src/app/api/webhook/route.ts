import Stripe from "stripe";
import { credit, ensureSchema, recordStripeEvent } from "@/lib/db";


// Stripe webhook: verifies the signature on the RAW body, dedupes by event id, and credits by session id
// (the same idempotency key as /api/topup/confirm), so neither path can double-credit.
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!secret || !key) return Response.json({ error: "webhook not configured" }, { status: 503 });
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";
  let event: Stripe.Event;
  try {
    event = new Stripe(key).webhooks.constructEvent(raw, sig, secret);
  } catch {
    return Response.json({ error: "invalid signature" }, { status: 400 });
  }
  await ensureSchema();
  const fresh = await recordStripeEvent(event.id, event.type);
  if (!fresh) return Response.json({ received: true, duplicate: true });
  if (event.type === "checkout.session.completed") {
    const s = event.data.object as Stripe.Checkout.Session;
    if (!s.livemode && s.payment_status === "paid") {
      await credit(`topup:${s.id}`, (s.amount_total ?? 0) * 10_000, "Stripe webhook (test mode)");
    }
  }
  return Response.json({ received: true, duplicate: false });
}
