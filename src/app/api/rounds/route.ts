import { randomUUID } from "node:crypto";
import { FAMILIES, type Family, PARTNER, sha256 } from "@/lib/bench/cases";
import { appendReport } from "@/lib/chainStore";
import { summariseEvents, type RoundBody } from "@/lib/evidence";
import { saveRoundEvents, type TimedEvent } from "@/lib/replay";
import { priceMicros, ROUND_CAP_MICROS } from "@/lib/cost";
import {
  ensureSchema, finishRoundRow, getActive, getHeldoutSet, insertTool, nextVersion, setActiveHeldout, tryStartRound,
} from "@/lib/db";
import { stripeApi } from "@/lib/cardHold";
import { capturePolicy, cardPayer, isBillable, walletPayer } from "@/lib/payer";
import { runRound, type RoundEvent } from "@/lib/round";
import { requireRole } from "@/lib/auth";

export const maxDuration = 300;

// Demo-only candidate that memorises the visible/field answers. It must be rejected by the held-out gate.
function cheatCode(family: Family): string {
  const table = Object.fromEntries([...FAMILIES[family].visible, ...FAMILIES[family].field].map((c) => [c.input, c.expected]));
  return `TABLE = ${JSON.stringify(table)}\n\ndef normalize(raw):\n    if raw in TABLE:\n        return TABLE[raw]\n    raise ValueError("unknown input")\n`;
}

export async function POST(req: Request) {
  const auth = await requireRole(req, ["operator", "admin", "shared"]);
  if (auth instanceof Response) return auth;
  const body = (await req.json().catch(() => ({}))) as { family?: Family; cheat?: boolean; simulateMissingUsage?: boolean; payWith?: "wallet" | "card_hold" };
  const family = body.family;
  if (!family || !FAMILIES[family]) return Response.json({ error: "family must be dates, money or durations" }, { status: 400 });

  await ensureSchema();
  const roundId = "r-" + randomUUID().slice(0, 8);
  if (!(await tryStartRound(roundId, family, auth.identity.id))) {
    return Response.json({ error: "another round is running (free plan allows one sandbox at a time)" }, { status: 409 });
  }
  // Who pays: the credit wallet (default) or a Stripe test-mode card hold (hold, run, capture the actual cost, free the rest).
  const payer = body.payWith === "card_hold" ? cardPayer(roundId, ROUND_CAP_MICROS, () => stripeApi()) : walletPayer(roundId, ROUND_CAP_MICROS);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const events: Record<string, unknown>[] = [];
      const timed: TimedEvent[] = []; // the same stream with timestamps, stored for replay
      const t0 = Date.now();
      const send = (e: RoundEvent) => {
        events.push(e as Record<string, unknown>);
        timed.push({ t: Date.now() - t0, e: e as Record<string, unknown> });
        if (e.type === "sandbox_created") sandboxStarted = true;
        controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      };
      let reserved = false;
      let sandboxStarted = false;
      let settledOrBlocked = false;
      let settlement: RoundBody["settlement"] = "blocked_unsettled";
      let costMicros: number | null = null;
      let recorded = false;
      // Append the tamper-evident report. A failure to record is surfaced to the client but never changes money or the verdict.
      const record = async (extra: Partial<RoundBody> & Pick<RoundBody, "status">) => {
        if (recorded) return;
        recorded = true;
        try {
          // Store the stream first so its digest can be sealed into the chain entry. If storing fails the round is still
          // reported (eventsSha null) and the client is told that replay will not be available.
          const snapshot = timed.slice(0, timed.length);
          let eventsSha: string | null = null;
          try {
            eventsSha = await saveRoundEvents(roundId, family, extra.status, snapshot);
          } catch (err) {
            send({ type: "report_error", message: "events not stored, so this round cannot be replayed: " + (err instanceof Error ? err.message : String(err)) });
          }
          const facts = summariseEvents(events);
          const payment = await payer.info().catch(() => undefined);
          const held = await getHeldoutSet(family).catch(() => null);
          const body: RoundBody = {
            kind: "round", roundId, family, pillar: FAMILIES[family].pillar, startedBy: auth.identity.id,
            toolId: null, candidate: null, visible: null, heldout: null, heldoutCommitment: held?.sha ?? null, cross: null, gate: null,
            egressBlocked: facts.egressBlocked, astOk: facts.astOk, sandboxId: facts.sandboxId,
            usage: { tokensIn: null, tokensOut: null, execMs: null }, costMicros: null, settlement, eventsSha, payment, at: new Date().toISOString(), ...extra,
          };
          const entry = await appendReport(body);
          send({ type: "report_sealed", seq: entry.seq, hash: entry.hash, signed: Boolean(entry.sig) });
        } catch (err) {
          send({ type: "report_error", message: err instanceof Error ? err.message : String(err) });
        }
      };
      try {
        // I1: authorise and reserve BEFORE any sandbox exists.
        const authz = await payer.authorize();
        if (!authz.ok) {
          await finishRoundRow(roundId, "refused", {}); // free the single running slot
          send({ type: "refused", reason: authz.reason, detail: authz.reason === "insufficient_funds" ? authz.detail : `${authz.detail}. No sandbox was created.` });
          return;
        }
        reserved = true;
        send(authz.event as RoundEvent);
        const active = await getActive(family);
        const partnerFamily = PARTNER[family];
        const partner = partnerFamily ? { family: partnerFamily, code: (await getActive(partnerFamily)).code } : undefined;

        const result = await runRound({
          family,
          currentCode: active.code,
          currentHeldoutPass: active.heldout_pass ?? undefined,
          partner,
          scripted: body.cheat ? { code: cheatCode(family), rationale: "SCRIPTED DEMO: memorises the visible answers" } : undefined,
          maxAttempts: body.cheat ? 1 : 2,
          emit: send,
        });

        // Remember the current tool's held-out standing the first time we measure it.
        if (!active.heldout_pass) await setActiveHeldout(active.id, result.currentHeldoutPass, result.currentVisibleCount);

        // I2: a simulated or real missing usage figure is never priced as zero.
        const unknown = result.usage.unknown || body.simulateMissingUsage === true; // operator-only demo flag: the route above already requires the passcode
        let status: string = result.verdict;
        let toolStatus: "proposed" | "rejected" | "blocked" = result.verdict === "proposed" ? "proposed" : "rejected";

        // I2/I3: unknown usage is never priced as zero, and a failed settlement can never become success.
        const actual = unknown ? null : priceMicros({ tokensIn: result.usage.tokensIn!, tokensOut: result.usage.tokensOut!, execMs: result.usage.execMs! });
        const settled = await payer.settle(actual, isBillable(capturePolicy(), result.verdict));
        settledOrBlocked = true;
        if (settled.kind === "blocked") {
          status = "blocked_unsettled";
          toolStatus = "blocked";
          send({ type: "blocked_unsettled", reason: settled.reason });
        } else {
          settlement = "settled";
          costMicros = settled.costMicros;
          send({ type: "settled", actualMicros: settled.costMicros, releasedMicros: settled.releasedMicros, mode: payer.mode, waived: settled.waived === true });
        }

        if (result.candidate) {
          const toolId = "t-" + family + "-" + roundId;
          await insertTool({
            id: toolId, family, version: await nextVersion(family), code: result.candidate.code, sha: sha256(result.candidate.code),
            status: toolStatus, visible_count: result.visible.candidate, heldout_count: result.heldout.candidate,
            heldout_pass: result.heldoutPass ?? null, heldout_sha: result.heldoutSha, round_id: roundId, rationale: result.candidate.rationale, gate: result.gate ?? null,
          });
          send({ type: "result", status, toolId, sha: sha256(result.candidate.code), visible: result.visible, heldout: result.heldout, gate: result.gate, needsApproval: toolStatus === "proposed" });
        }
        await record({
          status, toolId: result.candidate ? "t-" + family + "-" + roundId : null,
          candidate: result.candidate ? { sha: sha256(result.candidate.code), code: result.candidate.code } : null,
          visible: result.visible, heldout: result.heldout, cross: result.cross ?? null, gate: result.gate ?? null,
          usage: { tokensIn: result.usage.tokensIn, tokensOut: result.usage.tokensOut, execMs: result.usage.execMs }, costMicros,
        });
        await finishRoundRow(roundId, status, result.usage);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // A failed round must never look free: keep the hold and say why in the ledger.
        if (reserved && !settledOrBlocked) {
          if (!sandboxStarted) {
            // Failed before any sandbox or model call: usage is KNOWN to be zero (not unknown), so release the whole hold.
            await payer.releaseUnused().catch(() => {});
            settlement = "released";
            costMicros = 0;
            send({ type: "released", reason: "round failed before any sandbox ran; nothing was used" });
          } else {
            await payer.block(`round failed: ${message.slice(0, 120)}`).catch(() => {});
          }
        }
        send({ type: "error", message });
        if (reserved) await record({ status: "error", costMicros });
        await finishRoundRow(roundId, "error", {}).catch(() => {});
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
