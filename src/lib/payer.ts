// One interface for "who pays for this round": the internal credit wallet (default) or a Stripe test-mode card hold.
// The round route talks only to a Payer, so both modes obey the same Veloce rules:
//   1. authorize BEFORE any sandbox exists; a refusal means no round runs,
//   2. unknown usage is never settled as zero (the money stays held),
//   3. a failed settlement is a blocked round, never a success,
//   4. a round that failed before any sandbox ran releases everything (usage is known to be zero).
import { getHold, MICROS_PER_CENT, placeHold, releaseHold, markUnresolved, settleHold, type PaymentApi } from "./cardHold";
import { markBlocked, reserve, settle } from "./db";

export type PayMode = "wallet" | "card_hold";

export type AuthResult =
  | { ok: true; capMicros: number; event: Record<string, unknown> }
  | { ok: false; reason: "insufficient_funds" | "payment_declined" | "payment_unknown" | "payment_unavailable" | "payment_duplicate"; detail: string };

export type Settlement = { kind: "settled"; costMicros: number; releasedMicros: number; waived?: boolean } | { kind: "blocked"; reason: string };

/** Card rounds are charged only if policy says so. "always" (default): any completed round with known usage is charged the
 *  Stripe minimum. "on_green": only a round that produced a gate-passing proposal is charged; any other completed round
 *  is released. Unknown usage is never decided by policy. The wallet always charges the actual cost. */
export type CapturePolicy = "always" | "on_green";
export const capturePolicy = (env: NodeJS.ProcessEnv = process.env): CapturePolicy => (env.CARD_CAPTURE_POLICY === "on_green" ? "on_green" : "always");
export const isBillable = (policy: CapturePolicy, verdict: string) => policy === "always" || verdict === "proposed";

export interface PaymentInfo {
  mode: PayMode;
  paymentIntent: string | null;
  holdState: string | null;
  capturedCents: number | null;
}

export interface Payer {
  mode: PayMode;
  authorize(): Promise<AuthResult>;
  /** actualMicros === null means usage is unknown. billable=false (card mode only) waives the charge for a completed round. */
  settle(actualMicros: number | null, billable?: boolean): Promise<Settlement>;
  /** The round failed before any sandbox or model call: give everything back. */
  releaseUnused(): Promise<void>;
  /** The round failed after work began: usage is unknown, so keep the money held. */
  block(note: string): Promise<void>;
  info(): Promise<PaymentInfo>;
}

export function walletPayer(roundId: string, capMicros: number): Payer {
  return {
    mode: "wallet",
    async authorize() {
      return (await reserve(roundId, capMicros))
        ? { ok: true, capMicros, event: { type: "reserved", roundId, capMicros, mode: "wallet" } }
        : { ok: false, reason: "insufficient_funds", detail: "Add credits first. No sandbox was created." };
    },
    async settle(actual) {
      if (actual === null) {
        await markBlocked(roundId, capMicros, "usage unknown; reservation stays held");
        return { kind: "blocked", reason: "usage figure missing; hold kept; round cannot succeed" };
      }
      if (!(await settle(roundId, capMicros, actual))) {
        await markBlocked(roundId, capMicros, "settlement failed");
        return { kind: "blocked", reason: "settlement failed (overrun or duplicate)" };
      }
      return { kind: "settled", costMicros: actual, releasedMicros: capMicros - actual };
    },
    async releaseUnused() {
      await settle(roundId, capMicros, 0);
    },
    async block(note) {
      await markBlocked(roundId, capMicros, note);
    },
    async info() {
      return { mode: "wallet", paymentIntent: null, holdState: null, capturedCents: null };
    },
  };
}

/** `makeApi` is called lazily so a missing or live Stripe key becomes a clean refusal instead of a crash. */
export function cardPayer(roundId: string, capMicros: number, makeApi: () => PaymentApi): Payer {
  let api: PaymentApi | null = null;
  const get = () => (api ??= makeApi());
  return {
    mode: "card_hold",
    async authorize() {
      let a: PaymentApi;
      try {
        a = get();
      } catch (e) {
        return { ok: false, reason: "payment_unavailable", detail: e instanceof Error ? e.message : String(e) };
      }
      const r = await placeHold(a, roundId);
      if (r.ok) {
        return { ok: true, capMicros, event: { type: "reserved", roundId, capMicros, mode: "card_hold", paymentIntent: r.paymentIntent, holdCents: r.amountCents } };
      }
      const reason = r.reason === "declined" || r.reason === "not_test_mode" ? "payment_declined" : r.reason === "duplicate" ? "payment_duplicate" : "payment_unknown";
      return { ok: false, reason, detail: r.detail };
    },
    async settle(actual, billable = true) {
      const r = await settleHold(get(), roundId, actual, capMicros, billable);
      if (r.state === "captured") {
        return { kind: "settled", costMicros: r.capturedCents * MICROS_PER_CENT, releasedMicros: r.releasedCents * MICROS_PER_CENT };
      }
      if (r.state === "waived") return { kind: "settled", costMicros: 0, releasedMicros: r.releasedCents * MICROS_PER_CENT, waived: true };
      return { kind: "blocked", reason: r.reason };
    },
    async releaseUnused() {
      await releaseHold(get(), roundId);
    },
    async block(note) {
      await markUnresolved(roundId, note);
    },
    async info() {
      const h = await getHold(roundId);
      return { mode: "card_hold", paymentIntent: h?.payment_intent ?? null, holdState: h?.status ?? null, capturedCents: h?.captured_cents ?? null };
    },
  };
}
