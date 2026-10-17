import Stripe from "stripe";
import { TOPUP_CENTS } from "@/lib/cost";


// Stripe Checkout, TEST MODE ONLY: refuses any live key so no real money can move.
export async function POST(req: Request) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return Response.json({ error: "STRIPE_SECRET_KEY (test mode) is not configured" }, { status: 503 });
  if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
    return Response.json({ error: "refusing to run with a non-test Stripe key" }, { status: 500 });
  }
  const stripe = new Stripe(key);
  const origin = new URL(req.url).origin;
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      { quantity: 1, price_data: { currency: "usd", unit_amount: TOPUP_CENTS, product_data: { name: "Veloce Forge credits (test mode)" } } },
    ],
    success_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?canceled=1`,
  });
  return Response.json({ url: session.url });
}
