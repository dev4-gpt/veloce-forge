import { credit, ensureSchema, getWallet } from "@/lib/db";
import { requireRole } from "@/lib/auth";

// Fallback so the demo works without typing a card: $5 of clearly labelled demo credits, once per UTC day.
// It goes through the same idempotent, capped credit path as Stripe top-ups (see LIFETIME_TOPUP_CAP_MICROS).
// This is NOT a payment and is recorded in the ledger as such.
export async function POST(req: Request) {
  const auth = await requireRole(req, ["operator", "admin", "shared"]);
  if (auth instanceof Response) return auth;
  await ensureSchema();
  const day = new Date().toISOString().slice(0, 10);
  const credited = await credit(`demo:${day}`, 5_000_000, "Demo credits (not a payment)");
  return Response.json({ credited, wallet: await getWallet() });
}
