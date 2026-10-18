// Real Stripe TEST-MODE check of the assumptions behind src/lib/cardHold.ts:
//   1. a 50-cent manual-capture authorisation with Stripe's published test card is accepted,
//   2. a capture BELOW the 50-cent minimum is refused (found in a real run: partial billing of a few cents is impossible),
//      while a 50-cent capture succeeds,
//   3. cancelling an uncaptured authorisation works,
//   4. a second capture of the same intent is refused.
// Usage: npx tsx --env-file=.env.local scripts/stripe-hold-smoke.ts
// stripeApi() refuses any key that is not sk_test_/rk_test_, and every response is checked for livemode=false. No key is printed.
import { HOLD_CENTS, stripeApi, testPaymentMethod, type PI } from "../src/lib/cardHold";

const stamp = Date.now().toString(36);
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};
const show = (p: PI) => `${p.id} status=${p.status} amount=${p.amount} received=${p.amount_received} livemode=${p.livemode}`;

async function main() {
  const api = stripeApi();
  const make = (tag: string) =>
    api.create({ amount: HOLD_CENTS, paymentMethod: testPaymentMethod(), metadata: { round_id: `smoke-${stamp}-${tag}`, app: "veloce-forge-smoke" }, description: "Veloce Forge smoke test (test mode)" }, `smoke-hold:${stamp}:${tag}`);

  // 1 + 2: hold, then capture only 5 cents
  const a = await make("a");
  console.log(show(a));
  check("authorisation accepted, manual capture, test mode", a.status === "requires_capture" && a.amount === HOLD_CENTS && !a.livemode);
  let subMinimumRefused = "";
  try {
    await api.capture(a.id, 5, `smoke-capture5:${stamp}:a`);
  } catch (e) {
    subMinimumRefused = e instanceof Error ? e.message : String(e);
  }
  check("a capture of 5c (below the 50c minimum) is refused", /at least/i.test(subMinimumRefused), subMinimumRefused);
  const still = await api.retrieve(a.id);
  check("the refused capture left the authorisation intact", still.status === "requires_capture");
  const cap = await api.capture(a.id, 50, `smoke-capture:${stamp}:a`);
  console.log(show(cap));
  check("capture of 50c succeeds", cap.status === "succeeded" && cap.amount_received === 50 && !cap.livemode);
  const again = await api.retrieve(a.id);
  check("Stripe reports exactly 50c received", again.amount_received === 50);
  let secondCaptureRefused = false;
  try {
    await api.capture(a.id, 50, `smoke-capture2:${stamp}:a`);
  } catch {
    secondCaptureRefused = true;
  }
  check("a second capture of the same intent is refused", secondCaptureRefused);

  // 3: hold, then release
  const b = await make("b");
  console.log(show(b));
  const rel = await api.cancel(b.id, `smoke-release:${stamp}:b`);
  console.log(show(rel));
  check("cancelling an uncaptured authorisation works", rel.status === "canceled" && !rel.livemode);

  // idempotency: repeating the same create key returns the same intent, not a second authorisation
  const a2 = await make("a");
  check("repeating a create with the same idempotency key returns the same intent", a2.id === a.id);

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed (test mode, 2 test intents created, nothing real charged).");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
