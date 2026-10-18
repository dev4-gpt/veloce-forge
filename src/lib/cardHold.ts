// Stripe manual-capture card holds for rounds, TEST MODE ONLY.
//   authorize (hold) -> run the round -> capture the charge or cancel (release).
// VERIFIED AGAINST STRIPE TEST MODE: a capture below the 50-cent minimum charge is refused ("Amount must be at least $0.50 USD").
// So a card round cannot bill its exact (few-cent) cost: it bills the 50-cent minimum, or nothing. Use the wallet for exact metering.
// Veloce invariants kept here: the hold exists BEFORE any sandbox; unknown usage is never captured as zero and never silently
// released (the hold stays "unresolved" for a human); a failed settlement cannot become success; every state change is one
// compare-and-set so a retry or a second request cannot capture twice; and a request whose outcome is unknown is reconciled
// against Stripe instead of being guessed.
//
// Money is in cents at the Stripe boundary and micro-dollars elsewhere (1 cent = 10_000 micros).
import Stripe from "stripe";
import { ensureSchema, sql } from "./db";

export const HOLD_CENTS = 50; // Stripe's minimum card charge in USD: the authorisation cannot be smaller
export const MICROS_PER_CENT = 10_000;
export const centsFor = (micros: number) => Math.max(1, Math.ceil(micros / MICROS_PER_CENT));
/** What a card round is charged: the real cost rounded up, but never below Stripe's minimum charge. */
export const chargeCents = (micros: number) => Math.max(HOLD_CENTS, centsFor(micros));

export type HoldStatus = "authorizing" | "authorized" | "capturing" | "captured" | "releasing" | "released" | "failed" | "unresolved";

export interface HoldRow {
  round_id: string;
  payment_intent: string | null;
  amount_cents: number;
  status: HoldStatus;
  captured_cents: number | null;
  note: string | null;
}

// ---------- Stripe boundary (injectable so tests need no network) ----------
export interface PI {
  id: string;
  status: string; // requires_capture | succeeded | canceled | ...
  amount: number;
  amount_received: number;
  livemode: boolean;
}

export interface PaymentApi {
  create(p: { amount: number; paymentMethod: string; metadata: Record<string, string>; description: string }, idem: string): Promise<PI>;
  capture(id: string, amountToCapture: number, idem: string): Promise<PI>;
  cancel(id: string, idem: string): Promise<PI>;
  retrieve(id: string): Promise<PI>;
}

/** Real Stripe client. Refuses anything but a test-mode key, so no real money can move. */
export function stripeApi(env: NodeJS.ProcessEnv = process.env): PaymentApi {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY (test mode) is not configured");
  if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) throw new Error("refusing to run card holds with a non-test Stripe key");
  const s = new Stripe(key);
  const pick = (p: Stripe.PaymentIntent): PI => ({ id: p.id, status: p.status, amount: p.amount, amount_received: p.amount_received ?? 0, livemode: p.livemode });
  return {
    create: async (p, idem) =>
      pick(await s.paymentIntents.create(
        { amount: p.amount, currency: "usd", capture_method: "manual", confirm: true, payment_method: p.paymentMethod, allowed_payment_method_types: ["card"], metadata: p.metadata, description: p.description },
        { idempotencyKey: idem },
      )),
    capture: async (id, amount, idem) => pick(await s.paymentIntents.capture(id, { amount_to_capture: amount }, { idempotencyKey: idem })),
    cancel: async (id, idem) => pick(await s.paymentIntents.cancel(id, { cancellation_reason: "abandoned" }, { idempotencyKey: idem })),
    retrieve: async (id) => pick(await s.paymentIntents.retrieve(id)),
  };
}

/** Stripe's published test payment method. Override with STRIPE_HOLD_PAYMENT_METHOD (still test mode only). */
export const testPaymentMethod = (env: NodeJS.ProcessEnv = process.env) => env.STRIPE_HOLD_PAYMENT_METHOD || "pm_card_visa";

/** An error that proves Stripe did NOT act on the request (declined, invalid, rejected). Anything else (timeout, 5xx,
 *  dropped connection) is "unknown": the action may or may not have happened. */
export function isDefiniteFailure(e: unknown): boolean {
  const t = (e as { type?: string } | null)?.type;
  return t === "StripeCardError" || t === "StripeInvalidRequestError" || t === "StripeAuthenticationError" || t === "StripePermissionError" || t === "StripeRateLimitError" || t === "StripeIdempotencyError";
}
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);

// ---------- state store: every transition is a compare-and-set ----------
const toRow = (r: any): HoldRow => ({ round_id: r.round_id, payment_intent: r.payment_intent, amount_cents: Number(r.amount_cents), status: r.status, captured_cents: r.captured_cents === null ? null : Number(r.captured_cents), note: r.note });

export async function getHold(roundId: string): Promise<HoldRow | null> {
  await ensureSchema();
  const r = (await sql()`select * from card_holds where round_id = ${roundId}`) as any[];
  return r[0] ? toRow(r[0]) : null;
}

export async function listHolds(n = 15): Promise<HoldRow[]> {
  await ensureSchema();
  return ((await sql()`select * from card_holds order by created_at desc limit ${n}`) as any[]).map(toRow);
}

/** Holds that need attention: an outcome still being applied, or one a human must resolve. */
export async function listOpenHolds(): Promise<HoldRow[]> {
  await ensureSchema();
  return ((await sql()`select * from card_holds where status in ('authorizing','capturing','releasing','unresolved') order by created_at asc`) as any[]).map(toRow);
}

async function insertHold(roundId: string, cents: number): Promise<boolean> {
  const r = (await sql()`insert into card_holds(round_id, amount_cents, status) values (${roundId}, ${cents}, 'authorizing') on conflict (round_id) do nothing returning round_id`) as unknown[];
  return r.length > 0;
}
const setAuthorized = async (roundId: string, pi: string) =>
  ((await sql()`update card_holds set status = 'authorized', payment_intent = ${pi}, updated_at = now() where round_id = ${roundId} and status = 'authorizing' returning 1`) as unknown[]).length > 0;
const beginCapture = async (roundId: string, cents: number) =>
  ((await sql()`update card_holds set status = 'capturing', captured_cents = ${cents}, updated_at = now() where round_id = ${roundId} and status = 'authorized' and ${cents}::int <= amount_cents returning 1`) as unknown[]).length > 0;
const finishCapture = async (roundId: string, cents: number) =>
  ((await sql()`update card_holds set status = 'captured', captured_cents = ${cents}, updated_at = now() where round_id = ${roundId} and status in ('capturing','unresolved','releasing') returning 1`) as unknown[]).length > 0;
const beginRelease = async (roundId: string, from: "authorized" | "unresolved") =>
  ((await sql()`update card_holds set status = 'releasing', updated_at = now() where round_id = ${roundId} and status = ${from} and payment_intent is not null returning 1`) as unknown[]).length > 0;
const finishRelease = async (roundId: string) =>
  ((await sql()`update card_holds set status = 'released', updated_at = now() where round_id = ${roundId} and status = 'releasing' returning 1`) as unknown[]).length > 0;
async function setFailed(roundId: string, note: string) {
  await sql()`update card_holds set status = 'failed', note = ${note}, updated_at = now() where round_id = ${roundId} and status = 'authorizing'`;
}
/** Park a hold for a human. Never captures and never releases. Only from states where money may still be held. */
export async function markUnresolved(roundId: string, note: string): Promise<boolean> {
  return ((await sql()`update card_holds set status = 'unresolved', note = ${note}, updated_at = now() where round_id = ${roundId} and status in ('authorizing','authorized','capturing','releasing') returning 1`) as unknown[]).length > 0;
}

// ---------- flow ----------
export type HoldResult = { ok: true; paymentIntent: string; amountCents: number } | { ok: false; reason: "declined" | "unknown" | "duplicate" | "not_test_mode"; detail: string };

/** Place the hold BEFORE any sandbox exists. On failure no round runs. */
export async function placeHold(api: PaymentApi, roundId: string, env: NodeJS.ProcessEnv = process.env): Promise<HoldResult> {
  await ensureSchema();
  if (!(await insertHold(roundId, HOLD_CENTS))) return { ok: false, reason: "duplicate", detail: "a hold already exists for this round" };
  const idem = `hold:${roundId}`;
  let pi: PI;
  try {
    pi = await api.create({ amount: HOLD_CENTS, paymentMethod: testPaymentMethod(env), metadata: { round_id: roundId, app: "veloce-forge" }, description: `Veloce Forge round ${roundId} (test mode hold)` }, idem);
  } catch (e) {
    if (isDefiniteFailure(e)) {
      await setFailed(roundId, msg(e));
      return { ok: false, reason: "declined", detail: msg(e) };
    }
    // Unknown outcome and no payment intent id to look up: park it. It may exist at Stripe (metadata.round_id) and lapses by itself.
    await markUnresolved(roundId, "authorization outcome unknown: " + msg(e));
    return { ok: false, reason: "unknown", detail: msg(e) };
  }
  if (pi.livemode) {
    // Defence in depth on top of the key check: a live object must never be used. Cancel it if it somehow exists.
    await api.cancel(pi.id, `hold-cancel:${roundId}`).catch(() => {});
    await setFailed(roundId, "live-mode payment refused");
    return { ok: false, reason: "not_test_mode", detail: "Stripe returned a live-mode object; refused" };
  }
  if (pi.status !== "requires_capture" || pi.amount !== HOLD_CENTS) {
    await api.cancel(pi.id, `hold-cancel:${roundId}`).catch(() => {});
    await setFailed(roundId, `unexpected authorization state ${pi.status}/${pi.amount}`);
    return { ok: false, reason: "declined", detail: `card was not authorised (status ${pi.status})` };
  }
  if (!(await setAuthorized(roundId, pi.id))) return { ok: false, reason: "duplicate", detail: "hold changed state while authorising" };
  return { ok: true, paymentIntent: pi.id, amountCents: HOLD_CENTS };
}

export type SettleResult =
  | { state: "captured"; capturedCents: number; releasedCents: number }
  | { state: "waived"; releasedCents: number } // usage known, policy says do not charge: the whole hold was cancelled
  | { state: "unresolved"; reason: string }
  | { state: "pending"; reason: string }; // capture was sent but its outcome is unknown: reconcile it

/** Capture the charge for a finished round. actualMicros === null means usage is UNKNOWN: nothing is captured or released.
 *  billable === false (policy, e.g. pay-on-green) with KNOWN usage cancels the hold instead of capturing it. */
export async function settleHold(api: PaymentApi, roundId: string, actualMicros: number | null, capMicros: number, billable = true): Promise<SettleResult> {
  const hold = await getHold(roundId);
  if (!hold || !hold.payment_intent) return { state: "unresolved", reason: "no authorised hold for this round" };
  if (actualMicros === null || !Number.isFinite(actualMicros) || actualMicros < 0) {
    await markUnresolved(roundId, "usage unknown; hold kept for a human");
    return { state: "unresolved", reason: "usage unknown; hold kept (not captured, not released)" };
  }
  if (hold.status === "captured") return { state: "captured", capturedCents: hold.captured_cents ?? 0, releasedCents: hold.amount_cents - (hold.captured_cents ?? 0) };
  const cents = chargeCents(actualMicros);
  if (actualMicros > capMicros || cents > hold.amount_cents) {
    await markUnresolved(roundId, "cost exceeded the cap; nothing captured");
    return { state: "unresolved", reason: "cost exceeded the cap; hold kept, nothing captured" };
  }
  if (!billable) {
    const rel = await releaseHold(api, roundId);
    return rel.state === "released" ? { state: "waived", releasedCents: hold.amount_cents } : rel.state === "pending" ? { state: "pending", reason: rel.reason ?? "release outcome unknown" } : { state: "unresolved", reason: rel.reason ?? "release failed" };
  }
  if (!(await beginCapture(roundId, cents))) {
    const now = await getHold(roundId);
    return { state: "unresolved", reason: `hold is ${now?.status ?? "missing"}, not authorized` };
  }
  return applyCapture(api, roundId, hold.payment_intent, cents);
}

async function applyCapture(api: PaymentApi, roundId: string, pi: string, cents: number): Promise<SettleResult> {
  try {
    const out = await api.capture(pi, cents, `capture:${roundId}:${cents}`);
    if (out.status === "succeeded" && out.amount_received === cents && !out.livemode) {
      await finishCapture(roundId, cents);
      return { state: "captured", capturedCents: cents, releasedCents: out.amount - cents };
    }
    await markUnresolved(roundId, `capture returned ${out.status}/${out.amount_received}`);
    return { state: "unresolved", reason: `Stripe capture returned ${out.status}` };
  } catch (e) {
    if (isDefiniteFailure(e)) {
      await markUnresolved(roundId, "capture rejected: " + msg(e));
      return { state: "unresolved", reason: "capture rejected: " + msg(e) };
    }
    return { state: "pending", reason: "capture outcome unknown; reconcile before relying on it: " + msg(e) }; // row stays 'capturing'
  }
}

/** Release the whole hold: only for a round that failed before any sandbox or model call (usage is KNOWN to be zero). */
export async function releaseHold(api: PaymentApi, roundId: string): Promise<{ state: "released" | "pending" | "unresolved"; reason?: string }> {
  const hold = await getHold(roundId);
  if (!hold || !hold.payment_intent) return { state: "unresolved", reason: "no authorised hold" };
  if (hold.status === "released") return { state: "released" };
  if (!(await beginRelease(roundId, "authorized"))) return { state: "unresolved", reason: `hold is ${hold.status}, not authorized` };
  return applyRelease(api, roundId, hold.payment_intent);
}

async function applyRelease(api: PaymentApi, roundId: string, pi: string): Promise<{ state: "released" | "pending" | "unresolved"; reason?: string }> {
  try {
    const out = await api.cancel(pi, `release:${roundId}`);
    if (out.status === "canceled") {
      await finishRelease(roundId);
      return { state: "released" };
    }
    await markUnresolved(roundId, `cancel returned ${out.status}`);
    return { state: "unresolved", reason: `Stripe cancel returned ${out.status}` };
  } catch (e) {
    if (isDefiniteFailure(e)) {
      await markUnresolved(roundId, "release rejected: " + msg(e));
      return { state: "unresolved", reason: "release rejected: " + msg(e) };
    }
    return { state: "pending", reason: "release outcome unknown; reconcile: " + msg(e) };
  }
}

/** Bring one hold in line with what Stripe says. Safe to call repeatedly.
 *  It finishes work that was already decided ('capturing', 'releasing'), and it records an outcome Stripe has already reached
 *  for a parked hold. It NEVER decides to capture or release an 'unresolved' hold by itself. */
export async function reconcileHold(api: PaymentApi, roundId: string): Promise<{ before: HoldStatus | null; after: HoldStatus | null; detail: string }> {
  const hold = await getHold(roundId);
  if (!hold) return { before: null, after: null, detail: "no such hold" };
  const before = hold.status;
  if (!hold.payment_intent || before === "captured" || before === "released" || before === "failed" || before === "authorized") {
    return { before, after: before, detail: hold.payment_intent ? "nothing to reconcile" : "no payment intent id to look up" };
  }
  let pi: PI;
  try {
    pi = await api.retrieve(hold.payment_intent);
  } catch (e) {
    return { before, after: before, detail: "could not reach Stripe: " + msg(e) };
  }
  if (pi.status === "succeeded") {
    await finishCapture(roundId, pi.amount_received);
    return { before, after: (await getHold(roundId))?.status ?? null, detail: `Stripe shows captured ${pi.amount_received} cents` };
  }
  if (pi.status === "canceled") {
    if (before === "releasing") await finishRelease(roundId);
    else if (before === "unresolved") await sql()`update card_holds set status = 'released', note = 'released at Stripe (reconciled)', updated_at = now() where round_id = ${roundId} and status = 'unresolved'`;
    return { before, after: (await getHold(roundId))?.status ?? null, detail: "Stripe shows the authorisation was cancelled" };
  }
  if (pi.status === "requires_capture") {
    if (before === "capturing" && hold.captured_cents) {
      const r = await applyCapture(api, roundId, hold.payment_intent, hold.captured_cents);
      return { before, after: (await getHold(roundId))?.status ?? null, detail: `retried capture: ${r.state}` };
    }
    if (before === "releasing") {
      const r = await applyRelease(api, roundId, hold.payment_intent);
      return { before, after: (await getHold(roundId))?.status ?? null, detail: `retried release: ${r.state}` };
    }
    return { before, after: before, detail: "still authorised at Stripe; waiting for a human decision" };
  }
  return { before, after: before, detail: `Stripe status ${pi.status}` };
}

/** A human decides to give the money back for a parked hold (e.g. after investigating a round whose usage was unknown). */
export async function releaseUnresolved(api: PaymentApi, roundId: string): Promise<{ state: "released" | "pending" | "unresolved"; reason?: string }> {
  const hold = await getHold(roundId);
  if (!hold || hold.status !== "unresolved" || !hold.payment_intent) return { state: "unresolved", reason: "only an unresolved hold with a payment intent can be released this way" };
  if (!(await beginRelease(roundId, "unresolved"))) return { state: "unresolved", reason: "hold changed state" };
  return applyRelease(api, roundId, hold.payment_intent);
}
