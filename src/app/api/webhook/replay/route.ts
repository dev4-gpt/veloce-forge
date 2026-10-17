import { credit, ensureSchema, getWallet, latestTopupKey } from "@/lib/db";
import { requirePasscode } from "@/lib/auth";


// Demo button (I5): re-deliver the latest top-up through the same credit path. A replay must be a no-op.
export async function POST(req: Request) {
  const denied = requirePasscode(req);
  if (denied) return denied;
  await ensureSchema();
  const last = await latestTopupKey();
  if (!last) return Response.json({ error: "no top-up to replay yet" }, { status: 404 });
  const before = await getWallet();
  const credited = await credit(last.idem_key, last.amount_micros, "replay");
  const after = await getWallet();
  return Response.json({ replayed: last.idem_key, credited, balanceBefore: before.balance, balanceAfter: after.balance });
}
