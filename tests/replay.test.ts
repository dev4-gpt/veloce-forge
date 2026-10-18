// Run: npx tsx --test tests/replay.test.ts
// Replay of recorded runs: the playback plan, the integrity check against the sealed chain, the store (real SQL on PGlite),
// and a source-level check that the replay code cannot reach the wallet, the model or the sandbox.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { __setSqlForTests, ensureSchema, sql } from "../src/lib/db";
import { appendReport, readChain } from "../src/lib/chainStore";
import { sha256hex, verifyChain, type RoundBody } from "../src/lib/evidence";
import {
  checkIntegrity, eventsDigest, listRecordings, loadRecording, planReplay, REPLAY_NOTICE, saveRoundEvents, type Recording, type TimedEvent,
} from "../src/lib/replay";

const CODE = "def normalize(raw):\n    return raw.strip()\n";
const stream = (): TimedEvent[] => [
  { t: 5, e: { type: "reserved", roundId: "r-9", capMicros: 250000 } },
  { t: 900, e: { type: "sandbox_created", id: "sb-1", spawnMs: 800, egress: ["127.0.0.1"] } },
  { t: 20_000, e: { type: "candidate", attempt: 1, model: "m", rationale: "x", code: CODE, sha: sha256hex(CODE) } }, // 19 s of model time
  { t: 20_400, e: { type: "gate", attempt: 1, passed: true, reasons: [] } },
  { t: 20_500, e: { type: "settled", actualMicros: 40000, releasedMicros: 210000 } },
];
const rec = (events = stream()): Recording => ({ roundId: "r-9", family: "dates", status: "proposed", events, digest: eventsDigest(events), recordedAt: "2026-10-17T20:00:00.000Z" });
const sealedRound = (eventsSha: string | null | undefined): RoundBody => ({
  kind: "round", roundId: "r-9", family: "dates", pillar: "Command", startedBy: "u-op", status: "proposed", toolId: "t-dates-r-9",
  candidate: { sha: sha256hex(CODE), code: CODE }, visible: { current: 8, candidate: 12, total: 12 }, heldout: { current: 4, candidate: 10, total: 10 },
  heldoutCommitment: null, cross: null, gate: { passed: true, reasons: [] }, egressBlocked: true, astOk: true, sandboxId: "sb-1",
  usage: { tokensIn: 1, tokensOut: 1, execMs: 1 }, costMicros: 40000, settlement: "settled", eventsSha, at: "2026-10-17T20:00:21.000Z",
});
const NOT_SEALED = { state: "not_sealed", reason: "x" } as const;

// ---------- the playback plan ----------
test("every line of a replay is labelled replay:true and framed by start and end markers", () => {
  const plan = planReplay(rec(), NOT_SEALED);
  assert.equal(plan[0].line.type, "replay_start");
  assert.equal(plan.at(-1)!.line.type, "replay_end");
  assert.ok(plan.every((s) => s.line.replay === true));
  assert.equal(plan[0].line.notice, REPLAY_NOTICE);
  assert.equal(plan.length, stream().length + 2);
  assert.deepEqual(plan.slice(1, -1).map((s) => s.line.type), stream().map((x) => x.e.type));
});

test("a recorded event cannot opt out of the replay label or forge the replay frame", () => {
  const events: TimedEvent[] = [
    { t: 1, e: { type: "replay_start", replay: false, notice: "this is live" } },
    { t: 2, e: { type: "gate", passed: true, replay: false } },
    { t: 3, e: { type: "replay_end" } },
  ];
  const plan = planReplay(rec(events), NOT_SEALED);
  assert.deepEqual(plan.map((s) => s.line.type), ["replay_start", "gate", "replay_end"]);
  assert.equal(plan[0].line.notice, REPLAY_NOTICE);
  assert.equal(plan[1].line.replay, true);
});

test("pacing: long silences are shortened, speed is applied and clamped, the recording is not mutated", () => {
  const r = rec();
  const before = JSON.stringify(r.events);
  assert.deepEqual(planReplay(r, NOT_SEALED, { speed: 1 }).map((s) => s.delayMs), [0, 5, 895, 1500, 400, 100, 0]); // the 19 s model call becomes 1.5 s
  assert.deepEqual(planReplay(r, NOT_SEALED, { speed: 2 }).map((s) => s.delayMs), [0, 3, 448, 750, 200, 50, 0]);
  assert.equal(planReplay(r, NOT_SEALED, { speed: 1000 })[3].delayMs, Math.round(1500 / 8)); // clamped to 8x
  assert.equal(planReplay(r, NOT_SEALED, { speed: 0 })[3].delayMs, 3000); // clamped to 0.5x
  assert.equal(planReplay(r, NOT_SEALED, { speed: NaN })[3].delayMs, 1500);
  assert.equal(JSON.stringify(r.events), before);
});

test("out-of-order timestamps never produce a negative or growing delay", () => {
  const events: TimedEvent[] = [{ t: 500, e: { type: "a" } }, { t: 100, e: { type: "b" } }, { t: 600, e: { type: "c" } }];
  const delays = planReplay(rec(events), NOT_SEALED).map((s) => s.delayMs);
  assert.ok(delays.every((d) => d >= 0));
  assert.deepEqual(delays, [0, 500, 0, 100, 0]);
});

// ---------- store + integrity (real SQL) ----------
let pg: PGlite;
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
});

test("integrity: stored events match the digest sealed in the chain", async () => {
  const r = rec();
  await appendReport(sealedRound(r.digest), null);
  assert.deepEqual(checkIntegrity(r, await readChain()), { state: "matches_sealed_report", seq: 1 });
  assert.equal(verifyChain(await readChain()).ok, true); // the extra field does not disturb the chain rules
});

test("integrity: editing one stored event is caught", async () => {
  const r = rec();
  await appendReport(sealedRound(r.digest), null);
  const edited = { ...r, events: r.events.map((x, i) => (i === 3 ? { t: x.t, e: { ...x.e, passed: false } } : x)) };
  assert.equal(checkIntegrity(edited, await readChain()).state, "mismatch");
});

test("integrity: rewriting the stored events AND their stored digest is still caught by the sealed copy", async () => {
  const r = rec();
  await appendReport(sealedRound(r.digest), null);
  const forgedEvents = r.events.map((x, i) => (i === 3 ? { t: x.t, e: { ...x.e, reasons: ["nothing to see"] } } : x));
  const forged = { ...r, events: forgedEvents, digest: eventsDigest(forgedEvents) };
  assert.equal(checkIntegrity(forged, await readChain()).state, "mismatch");
});

test("integrity: missing seal or missing events digest is reported as not sealed, never as verified", async () => {
  const r = rec();
  assert.equal(checkIntegrity(r, await readChain()).state, "not_sealed"); // empty chain
  await appendReport(sealedRound(null), null);
  assert.equal(checkIntegrity(r, await readChain()).state, "not_sealed");
});

test("store: a saved recording loads back identically, with the same digest", async () => {
  const events = stream();
  const digest = await saveRoundEvents("r-9", "dates", "proposed", events);
  const back = await loadRecording("r-9");
  assert.ok(back);
  assert.deepEqual(back.events, events);
  assert.equal(back.digest, digest);
  assert.equal(eventsDigest(back.events), digest);
  assert.equal(await loadRecording("r-nope"), null);
});

test("store: recordings are immutable, and a second save cannot replace the first or change its digest", async () => {
  const first = await saveRoundEvents("r-9", "dates", "proposed", stream());
  const second = await saveRoundEvents("r-9", "dates", "proposed", [{ t: 1, e: { type: "gate", passed: true } }]);
  assert.equal(second, first); // returns the digest that is actually stored
  assert.equal((await loadRecording("r-9"))!.events.length, stream().length);
  await assert.rejects(async () => { await sql()`update round_events set events_json = '[]' where round_id = 'r-9'`; }, /append-only/);
  await assert.rejects(async () => { await sql()`delete from round_events where round_id = 'r-9'`; }, /append-only/);
});

test("store: listing returns newest first with event counts", async () => {
  await saveRoundEvents("r-a", "dates", "rejected", stream());
  await new Promise((r) => setTimeout(r, 15));
  await saveRoundEvents("r-b", "money", "proposed", stream().slice(0, 2));
  const list = await listRecordings();
  assert.deepEqual(list.map((x) => [x.roundId, x.eventCount]), [["r-b", 2], ["r-a", 5]]);
});

// ---------- replay cannot spend, call a model or start a sandbox ----------
test("replay code never imports the wallet, the round runner, the sandbox client or the model client", () => {
  const files = ["src/lib/replay.ts", "src/app/api/replay/route.ts", "src/app/api/replay/[round]/route.ts"];
  for (const f of files) {
    const src = readFileSync(join(process.cwd(), f), "utf8");
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const bad of ["round", "sandbox", "gemini", "llm", "cost", "stripe", "auth"]) {
      assert.ok(!imports.some((i) => i.includes(bad)), `${f} imports something matching "${bad}": ${imports.join(", ")}`);
    }
    const code = src.replace(/\/\/.*$/gm, "");
    for (const fn of ["reserve", "settle", "credit", "markBlocked", "runRound", "tryStartRound", "insertTool", "review"]) {
      assert.ok(!new RegExp(`\\b${fn}\\b`).test(code), `${f} mentions ${fn}`);
    }
  }
});
