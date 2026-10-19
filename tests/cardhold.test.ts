// Run: npx tsx --test tests/cardhold.test.ts
// Stripe card holds (src/lib/cardHold.ts) and the Payer abstraction (src/lib/payer.ts) against a fake Stripe that keeps real
// PaymentIntent semantics (manual capture, partial capture, idempotency keys, cancel) and real SQL on PGlite. No network.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { __setSqlForTests, credit, ensureSchema, getWallet, sql } from "../src/lib/db";
import {
  centsFor, chargeCents, getHold, HOLD_CENTS, isDefiniteFailure, listOpenHolds, placeHold, reconcileHold, releaseHold, releaseUnresolved, settleHold,
  stripeApi, type PaymentApi, type PI,
} from "../src/lib/cardHold";
import { capturePolicy, cardPayer, isBillable, walletPayer } from "../src/lib/payer";

const CAP = 250_000;
const stripeErr = (type: string, message = type) => Object.assign(new Error(message), { type });

/** In-memory Stripe: manual-capture PaymentIntents with partial capture, cancel, retrieve and idempotency-key replay. */
class FakeStripe implements PaymentApi {
  calls: { op: string; args: unknown[] }[] = [];
  pis = new Map<string, PI>();
  idem = new Map<string, PI>();
  n = 0;
  failNext: { op: string; err: unknown; applyFirst?: boolean }[] = [];
  livemode = false;
  statusAfterCreate = "requires_capture";
  count = (op: string) => this.calls.filter((c) => c.op === op).length;

  private maybeFail(op: string, apply: () => void) {
    const i = this.failNext.findIndex((f) => f.op === op);
    if (i < 0) return;
    const [f] = this.failNext.splice(i, 1);
    if (f.applyFirst) apply(); // the request reached Stripe and took effect, but the response was lost
    throw f.err;
  }
  private once(key: string, make: () => PI): PI {
    const hit = this.idem.get(key);
    if (hit) return { ...hit };
    const out = make();
    this.idem.set(key, { ...out });
    return out;
  }
  async create(p: Parameters<PaymentApi["create"]>[0], idem: string) {
    this.calls.push({ op: "create", args: [p, idem] });
    const apply = () =>
      this.once(idem, () => {
        const pi = { id: `pi_${++this.n}`, status: this.statusAfterCreate, amount: p.amount, amount_received: 0, livemode: this.livemode };
        this.pis.set(pi.id, pi);
        return pi;
      });
    this.maybeFail("create", apply);
    return apply();
  }
  async capture(id: string, amountToCapture: number, idem: string) {
    this.calls.push({ op: "capture", args: [id, amountToCapture, idem] });
    const apply = () =>
      this.once(idem, () => {
        const pi = this.pis.get(id)!;
        if (pi.status !== "requires_capture") throw stripeErr("StripeInvalidRequestError", "not capturable");
        if (amountToCapture < 50) throw stripeErr("StripeInvalidRequestError", "Amount must be at least $0.50 USD"); // verified against real Stripe test mode
        pi.status = "succeeded";
        pi.amount_received = amountToCapture; // Stripe releases the uncaptured remainder itself
        return { ...pi };
      });
    this.maybeFail("capture", apply);
    return apply();
  }
  async cancel(id: string, idem: string) {
    this.calls.push({ op: "cancel", args: [id, idem] });
    const apply = () =>
      this.once(idem, () => {
        const pi = this.pis.get(id)!;
        if (pi.status !== "requires_capture") throw stripeErr("StripeInvalidRequestError", "cannot cancel " + pi.status);
        pi.status = "canceled";
        return { ...pi };
      });
    this.maybeFail("cancel", apply);
    return apply();
  }
  async retrieve(id: string) {
    this.calls.push({ op: "retrieve", args: [id] });
    this.maybeFail("retrieve", () => {});
    return { ...this.pis.get(id)! };
  }
}

let pg: PGlite;
let api: FakeStripe;
before(async () => {
  pg = new PGlite();
});
after(async () => {
  __setSqlForTests(null);
  await pg.close();
});
beforeEach(async () => {
  await pg.exec("drop schema public cascade; create schema public;");
  __setSqlForTests(async (strings, ...values) => {
    const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""), "");
    return (await pg.query(text, values as unknown[])).rows as unknown[];
  });
  await ensureSchema();
  api = new FakeStripe();
});

const place = async (r = "r-1") => {
  const h = await placeHold(api, r);
  assert.equal(h.ok, true);
  return h;
};

// ---------- guards ----------
test("only test-mode Stripe keys are accepted", () => {
  const env = (k?: string) => (k ? { STRIPE_SECRET_KEY: k } : {}) as unknown as NodeJS.ProcessEnv;
  assert.throws(() => stripeApi(env("sk_live_abc")), /non-test/);
  assert.throws(() => stripeApi(env("rk_live_abc")), /non-test/);
  assert.throws(() => stripeApi(env("pk_test_abc")), /non-test/);
  assert.throws(() => stripeApi(env()), /not configured/);
  assert.ok(stripeApi(env("sk_test_abc"))); // constructing makes no network call
});

test("cents are rounded up and never zero", () => {
  assert.equal(centsFor(1), 1);
  assert.equal(centsFor(0), 1);
  assert.equal(centsFor(10_000), 1);
  assert.equal(centsFor(10_001), 2);
  assert.equal(centsFor(43_000), 5);
});

test("a card round is charged the real cost rounded up but never below Stripe's 50-cent minimum", () => {
  assert.equal(chargeCents(1), 50);
  assert.equal(chargeCents(43_000), 50);
  assert.equal(chargeCents(500_000), 50);
  assert.equal(chargeCents(500_001), 51);
});

test("the fake enforces the real Stripe rule: a sub-minimum capture is refused", async () => {
  await place();
  await assert.rejects(() => api.capture("pi_1", 5, "k"), /at least \$0.50/);
});

test("only errors that prove Stripe did not act are 'definite'", () => {
  for (const t of ["StripeCardError", "StripeInvalidRequestError", "StripeAuthenticationError", "StripeRateLimitError"]) assert.equal(isDefiniteFailure(stripeErr(t)), true);
  for (const t of ["StripeConnectionError", "StripeAPIError", "SomethingElse"]) assert.equal(isDefiniteFailure(stripeErr(t)), false);
  assert.equal(isDefiniteFailure(new Error("timeout")), false);
  assert.equal(isDefiniteFailure(null), false);
});

// ---------- hold ----------
test("placing a hold sends a manual-capture authorisation with an idempotency key and records it", async () => {
  const h = await place();
  assert.equal(h.ok && h.amountCents, HOLD_CENTS);
  const [p, idem] = api.calls[0].args as [Parameters<PaymentApi["create"]>[0], string];
  assert.equal(p.amount, 50);
  assert.equal(p.paymentMethod, "pm_card_visa");
  assert.equal(p.metadata.round_id, "r-1");
  assert.equal(idem, "hold:r-1");
  const row = await getHold("r-1");
  assert.equal(row?.status, "authorized");
  assert.equal(row?.payment_intent, "pi_1");
});

test("a declined card leaves no usable hold and no payment intent", async () => {
  api.failNext.push({ op: "create", err: stripeErr("StripeCardError", "Your card was declined") });
  const h = await placeHold(api, "r-1");
  assert.equal(h.ok, false);
  assert.equal(!h.ok && h.reason, "declined");
  const row = await getHold("r-1");
  assert.equal(row?.status, "failed");
  assert.equal(row?.payment_intent, null);
});

test("an authorisation whose outcome is unknown is parked, never treated as success", async () => {
  api.failNext.push({ op: "create", err: stripeErr("StripeConnectionError", "socket hang up"), applyFirst: true });
  const h = await placeHold(api, "r-1");
  assert.equal(h.ok, false);
  assert.equal(!h.ok && h.reason, "unknown");
  assert.equal((await getHold("r-1"))?.status, "unresolved");
  assert.equal((await listOpenHolds()).length, 1);
});

test("a live-mode object is cancelled and refused even if it somehow appears", async () => {
  api.livemode = true;
  const h = await placeHold(api, "r-1");
  assert.equal(!h.ok && h.reason, "not_test_mode");
  assert.equal(api.count("cancel"), 1);
  assert.equal((await getHold("r-1"))?.status, "failed");
});

test("an authorisation that is not capturable (needs customer action) is refused and a cancel is attempted", async () => {
  api.statusAfterCreate = "requires_action";
  const h = await placeHold(api, "r-1");
  assert.equal(h.ok, false);
  assert.equal(api.count("cancel"), 1);
  assert.equal((await getHold("r-1"))?.status, "failed");
});

test("a second hold for the same round is refused without calling Stripe", async () => {
  await place();
  const calls = api.count("create");
  const again = await placeHold(api, "r-1");
  assert.equal(!again.ok && again.reason, "duplicate");
  assert.equal(api.count("create"), calls);
});

// ---------- capture ----------
test("a finished round is charged the 50-cent minimum, and never asks Stripe for less", async () => {
  await place();
  const r = await settleHold(api, "r-1", 43_000, CAP);
  assert.deepEqual(r, { state: "captured", capturedCents: 50, releasedCents: 0 });
  assert.deepEqual(api.calls.filter((c) => c.op === "capture").map((c) => c.args), [["pi_1", 50, "capture:r-1:50"]]);
  const row = await getHold("r-1");
  assert.equal(row?.status, "captured");
  assert.equal(row?.captured_cents, 50);
  assert.equal(api.pis.get("pi_1")?.amount_received, 50);
});

test("policy waive: a completed round that is not billable cancels the hold and charges nothing", async () => {
  await place();
  const r = await settleHold(api, "r-1", 43_000, CAP, false);
  assert.deepEqual(r, { state: "waived", releasedCents: 50 });
  assert.equal(api.count("capture"), 0);
  assert.equal(api.pis.get("pi_1")?.status, "canceled");
  assert.equal((await getHold("r-1"))?.status, "released");
});

test("policy never decides money when usage is unknown, even for a non-billable round", async () => {
  await place();
  const r = await settleHold(api, "r-1", null, CAP, false);
  assert.equal(r.state, "unresolved");
  assert.equal(api.count("cancel"), 0);
  assert.equal(api.count("capture"), 0);
});

test("capture policy: default charges every completed round; on_green charges only gate-passing proposals", () => {
  const env = (v?: string) => (v ? { CARD_CAPTURE_POLICY: v } : {}) as unknown as NodeJS.ProcessEnv;
  assert.equal(capturePolicy(env()), "always");
  assert.equal(capturePolicy(env("nonsense")), "always");
  assert.equal(capturePolicy(env("on_green")), "on_green");
  assert.equal(isBillable("always", "rejected"), true);
  assert.equal(isBillable("on_green", "rejected"), false);
  assert.equal(isBillable("on_green", "proposed"), true);
});

test("settling twice, or twice at once, captures exactly once", async () => {
  await place();
  const [a, b] = await Promise.all([settleHold(api, "r-1", 43_000, CAP), settleHold(api, "r-1", 43_000, CAP)]);
  assert.equal(api.count("capture"), 1);
  assert.ok([a, b].some((x) => x.state === "captured"));
  assert.equal((await settleHold(api, "r-1", 43_000, CAP)).state, "captured");
  assert.equal(api.count("capture"), 1);
});

test("unknown usage captures nothing and releases nothing: the hold is parked for a person", async () => {
  await place();
  const r = await settleHold(api, "r-1", null, CAP);
  assert.equal(r.state, "unresolved");
  assert.equal(api.count("capture"), 0);
  assert.equal(api.count("cancel"), 0);
  assert.equal((await getHold("r-1"))?.status, "unresolved");
  assert.equal(api.pis.get("pi_1")?.status, "requires_capture"); // the money is still held at Stripe
});

test("a cost above the cap captures nothing", async () => {
  await place();
  const r = await settleHold(api, "r-1", CAP + 1, CAP);
  assert.equal(r.state, "unresolved");
  assert.equal(api.count("capture"), 0);
});

test("a capture Stripe rejects never becomes 'captured'", async () => {
  await place();
  api.failNext.push({ op: "capture", err: stripeErr("StripeInvalidRequestError", "charge_expired_for_capture") });
  const r = await settleHold(api, "r-1", 43_000, CAP);
  assert.equal(r.state, "unresolved");
  assert.equal((await getHold("r-1"))?.status, "unresolved");
});

test("a capture response with the wrong amount is not accepted", async () => {
  await place();
  const real = api.capture.bind(api);
  api.capture = async (id, amt, idem) => ({ ...(await real(id, amt, idem)), amount_received: amt + 1 });
  const r = await settleHold(api, "r-1", 43_000, CAP);
  assert.equal(r.state, "unresolved");
  assert.notEqual((await getHold("r-1"))?.status, "captured");
});

test("capture whose response is lost: reported pending, then reconciled to captured without a second charge", async () => {
  await place();
  api.failNext.push({ op: "capture", err: stripeErr("StripeConnectionError", "ECONNRESET"), applyFirst: true });
  const r = await settleHold(api, "r-1", 43_000, CAP);
  assert.equal(r.state, "pending");
  assert.equal((await getHold("r-1"))?.status, "capturing");
  const rec = await reconcileHold(api, "r-1");
  assert.equal(rec.after, "captured");
  assert.equal((await getHold("r-1"))?.captured_cents, 50);
  assert.equal(api.count("capture"), 1); // reconcile only looked; the capture had already happened
  assert.equal((await reconcileHold(api, "r-1")).after, "captured"); // idempotent
});

test("capture that never reached Stripe: reconcile retries it with the SAME idempotency key", async () => {
  await place();
  api.failNext.push({ op: "capture", err: stripeErr("StripeConnectionError", "ETIMEDOUT") });
  assert.equal((await settleHold(api, "r-1", 43_000, CAP)).state, "pending");
  assert.equal((await reconcileHold(api, "r-1")).after, "captured");
  assert.deepEqual(api.calls.filter((c) => c.op === "capture").map((c) => c.args[2]), ["capture:r-1:50", "capture:r-1:50"]);
  assert.equal(api.pis.get("pi_1")?.amount_received, 50);
});

// ---------- release ----------
test("a round that never ran releases the whole hold, once", async () => {
  await place();
  assert.deepEqual(await releaseHold(api, "r-1"), { state: "released" });
  assert.equal(api.pis.get("pi_1")?.status, "canceled");
  assert.deepEqual(await releaseHold(api, "r-1"), { state: "released" });
  assert.equal(api.count("cancel"), 1);
});

test("a captured hold can never be released afterwards, and a released one can never be captured", async () => {
  await place("r-a");
  await settleHold(api, "r-a", 43_000, CAP);
  assert.equal((await releaseHold(api, "r-a")).state, "unresolved");
  assert.equal(api.count("cancel"), 0);
  await place("r-b");
  await releaseHold(api, "r-b");
  assert.equal((await settleHold(api, "r-b", 43_000, CAP)).state, "unresolved");
  assert.equal(api.count("capture"), 1);
});

test("a release whose response is lost is reconciled to released", async () => {
  await place();
  api.failNext.push({ op: "cancel", err: stripeErr("StripeConnectionError", "reset"), applyFirst: true });
  assert.equal((await releaseHold(api, "r-1")).state, "pending");
  assert.equal((await getHold("r-1"))?.status, "releasing");
  assert.equal((await reconcileHold(api, "r-1")).after, "released");
});

// ---------- parked holds ----------
test("reconcile never decides money for a parked hold; a person releases it", async () => {
  await place();
  await settleHold(api, "r-1", null, CAP);
  assert.equal((await reconcileHold(api, "r-1")).after, "unresolved");
  assert.equal(api.count("capture"), 0);
  assert.equal(api.count("cancel"), 0);
  assert.equal((await releaseUnresolved(api, "r-1")).state, "released");
  assert.equal(api.pis.get("pi_1")?.status, "canceled");
  assert.equal((await releaseUnresolved(api, "r-1")).state, "unresolved"); // not parked any more
});

test("reconcile records an outcome Stripe has already reached for a parked hold", async () => {
  await place("r-a");
  await settleHold(api, "r-a", null, CAP);
  api.pis.get("pi_1")!.status = "canceled"; // e.g. the authorisation lapsed or was cancelled in the dashboard
  assert.equal((await reconcileHold(api, "r-a")).after, "released");
  await place("r-b");
  await settleHold(api, "r-b", null, CAP);
  Object.assign(api.pis.get("pi_2")!, { status: "succeeded", amount_received: 7 });
  assert.equal((await reconcileHold(api, "r-b")).after, "captured");
  assert.equal((await getHold("r-b"))?.captured_cents, 7);
});

test("releaseUnresolved refuses holds that are not parked", async () => {
  await place();
  assert.equal((await releaseUnresolved(api, "r-1")).state, "unresolved");
  assert.equal(api.count("cancel"), 0);
});

// ---------- payers: both modes obey the same rules ----------
test("wallet payer: refuses without funds, holds, settles actual cost, never settles unknown usage as zero", async () => {
  const p = walletPayer("r-w", CAP);
  const none = await p.authorize();
  assert.equal(!none.ok && none.reason, "insufficient_funds");
  await credit("k", 1_000_000, "t");
  assert.equal((await p.authorize()).ok, true);
  assert.deepEqual(await getWallet(), { balance: 750_000, held: 250_000 });
  assert.equal((await p.settle(null)).kind, "blocked");
  assert.equal((await getWallet()).held, 250_000); // still held, not zero
  const q = walletPayer("r-w2", CAP);
  await q.authorize();
  assert.deepEqual(await q.settle(40_000), { kind: "settled", costMicros: 40_000, releasedMicros: 210_000 });
});

test("wallet payer: a round that never ran releases everything", async () => {
  await credit("k", 1_000_000, "t");
  const p = walletPayer("r-w", CAP);
  await p.authorize();
  await p.releaseUnused();
  assert.deepEqual(await getWallet(), { balance: 1_000_000, held: 0 });
});

test("card payer: unavailable when the Stripe key is not a test key, and nothing is created", async () => {
  const p = cardPayer("r-c", CAP, () => stripeApi({ STRIPE_SECRET_KEY: "sk_live_x" } as unknown as NodeJS.ProcessEnv));
  const a = await p.authorize();
  assert.equal(!a.ok && a.reason, "payment_unavailable");
  assert.equal(await getHold("r-c"), null);
});

test("card payer: authorise, run, capture the actual cost; the report info shows what happened", async () => {
  const p = cardPayer("r-c", CAP, () => api);
  const a = await p.authorize();
  assert.equal(a.ok && a.event.type, "reserved");
  assert.equal(a.ok && a.event.mode, "card_hold");
  assert.deepEqual(await p.settle(43_000), { kind: "settled", costMicros: 500_000, releasedMicros: 0 });
  assert.deepEqual(await p.info(), { mode: "card_hold", paymentIntent: "pi_1", holdState: "captured", capturedCents: 50 });
  const w = cardPayer("r-w", CAP, () => api);
  await w.authorize();
  assert.deepEqual(await w.settle(43_000, false), { kind: "settled", costMicros: 0, releasedMicros: 500_000, waived: true });
  assert.equal((await w.info()).holdState, "released");
});

test("card payer: declined card refuses the round; unknown usage keeps the hold; failed-before-sandbox releases it", async () => {
  api.failNext.push({ op: "create", err: stripeErr("StripeCardError", "declined") });
  const r = await cardPayer("r-d", CAP, () => api).authorize();
  assert.equal(!r.ok && r.reason, "payment_declined");

  const u = cardPayer("r-u", CAP, () => api);
  await u.authorize();
  assert.equal((await u.settle(null)).kind, "blocked");
  assert.equal((await u.info()).holdState, "unresolved");
  assert.equal(api.count("capture"), 0);

  const f = cardPayer("r-f", CAP, () => api);
  await f.authorize();
  await f.releaseUnused();
  assert.equal((await f.info()).holdState, "released");

  const b = cardPayer("r-b", CAP, () => api);
  await b.authorize();
  await b.block("round failed after work began");
  assert.equal((await b.info()).holdState, "unresolved");
  const piId = (await b.info()).paymentIntent!;
  assert.equal(api.pis.get(piId)?.status, "requires_capture"); // work began: money stays held, not released
});

test("the wallet is untouched by card-hold rounds", async () => {
  await credit("k", 1_000_000, "t");
  const p = cardPayer("r-c", CAP, () => api);
  await p.authorize();
  await p.settle(43_000);
  assert.deepEqual(await getWallet(), { balance: 1_000_000, held: 0 });
  const ledger = (await sql()`select count(*) as n from ledger where round_id = 'r-c'`) as { n: number }[];
  assert.equal(Number(ledger[0].n), 0);
});
