import { randomUUID } from "node:crypto";
import { FAMILIES, type Family, sha256 } from "@/lib/bench/cases";
import { priceMicros, ROUND_CAP_MICROS } from "@/lib/cost";
import {
  ensureSchema, finishRoundRow, getActive, insertTool, markBlocked, nextVersion, reserve, roundIsRunning,
  setActiveHeldout, settle, startRoundRow,
} from "@/lib/db";
import { runRound, type RoundEvent } from "@/lib/round";
import { requirePasscode } from "@/lib/auth";

export const maxDuration = 300;

// Demo-only candidate that memorises the visible/field answers. It must be rejected by the held-out gate.
function cheatCode(family: Family): string {
  const table = Object.fromEntries([...FAMILIES[family].visible, ...FAMILIES[family].field].map((c) => [c.input, c.expected]));
  return `TABLE = ${JSON.stringify(table)}\n\ndef normalize(raw):\n    if raw in TABLE:\n        return TABLE[raw]\n    raise ValueError("unknown input")\n`;
}

export async function POST(req: Request) {
  const denied = requirePasscode(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { family?: Family; cheat?: boolean; simulateMissingUsage?: boolean };
  const family = body.family;
  if (!family || !FAMILIES[family]) return Response.json({ error: "family must be dates, money or durations" }, { status: 400 });

  await ensureSchema();
  if (await roundIsRunning()) return Response.json({ error: "another round is running (free plan allows one sandbox at a time)" }, { status: 409 });

  const roundId = "r-" + randomUUID().slice(0, 8);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: RoundEvent) => {
        if (e.type === "sandbox_created") sandboxStarted = true;
        controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      };
      let reserved = false;
      let sandboxStarted = false;
      let settledOrBlocked = false;
      try {
        // I1: authorise and reserve BEFORE any sandbox exists.
        const ok = await reserve(roundId, ROUND_CAP_MICROS);
        if (!ok) {
          send({ type: "refused", reason: "insufficient_funds", detail: "Add credits first. No sandbox was created." });
          return;
        }
        reserved = true;
        send({ type: "reserved", roundId, capMicros: ROUND_CAP_MICROS });
        await startRoundRow(roundId, family);
        const active = await getActive(family);

        const result = await runRound({
          family,
          currentCode: active.code,
          currentHeldoutPass: active.heldout_pass ?? undefined,
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

        if (unknown) {
          status = "blocked_unsettled";
          toolStatus = "blocked";
          await markBlocked(roundId, ROUND_CAP_MICROS, "usage unknown; reservation stays held");
          settledOrBlocked = true;
          send({ type: "blocked_unsettled", reason: "usage figure missing; hold kept; round cannot succeed" });
        } else {
          const actual = priceMicros({ tokensIn: result.usage.tokensIn!, tokensOut: result.usage.tokensOut!, execMs: result.usage.execMs! });
          const settled = await settle(roundId, ROUND_CAP_MICROS, actual);
          if (!settled) {
            // I3: failed settlement (e.g. overrun) can never become success.
            status = "blocked_unsettled";
            toolStatus = "blocked";
            await markBlocked(roundId, ROUND_CAP_MICROS, "settlement failed");
            settledOrBlocked = true;
            send({ type: "blocked_unsettled", reason: "settlement failed (overrun or duplicate)" });
          } else {
            settledOrBlocked = true;
            send({ type: "settled", actualMicros: actual, releasedMicros: ROUND_CAP_MICROS - actual });
          }
        }

        if (result.candidate) {
          const toolId = "t-" + family + "-" + roundId;
          await insertTool({
            id: toolId, family, version: await nextVersion(family), code: result.candidate.code, sha: sha256(result.candidate.code),
            status: toolStatus, visible_count: result.visible.candidate, heldout_count: result.heldout.candidate,
            heldout_pass: result.heldoutPass ?? null, round_id: roundId, rationale: result.candidate.rationale, gate: result.gate ?? null,
          });
          send({ type: "result", status, toolId, sha: sha256(result.candidate.code), visible: result.visible, heldout: result.heldout, gate: result.gate, needsApproval: toolStatus === "proposed" });
        }
        await finishRoundRow(roundId, status, result.usage);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // A failed round must never look free: keep the hold and say why in the ledger.
        if (reserved && !settledOrBlocked) {
          if (!sandboxStarted) {
            // Failed before any sandbox or model call: usage is KNOWN to be zero (not unknown), so release the whole hold.
            await settle(roundId, ROUND_CAP_MICROS, 0).catch(() => {});
            send({ type: "released", reason: "round failed before any sandbox ran; nothing was used" });
          } else {
            await markBlocked(roundId, ROUND_CAP_MICROS, `round failed: ${message.slice(0, 120)}`).catch(() => {});
          }
        }
        send({ type: "error", message });
        await finishRoundRow(roundId, "error", {}).catch(() => {});
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
