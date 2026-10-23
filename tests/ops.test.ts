// Run: npx tsx --test tests/ops.test.ts
// Operations safety nets found in the live deploy: releasing wallet holds that a killed round left behind (real SQL on PGlite), and
// cleaning up sandboxes a killed round leaked (fake sandbox calls, no CreateOS quota used).
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { __setSqlForTests, credit, ensureSchema, finishRoundRow, getWallet, listStuckHolds, markBlocked, releaseStuckHold, reserve, settle, sql, tryStartRound } from "../src/lib/db";
import { createSandboxReaping, SandboxError, STALE_SANDBOX_MS, staleSandboxIds, type ReapDeps } from "../src/lib/sandbox/client";

// ---------- stuck wallet holds ----------
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

/** A round that reserved money and was then killed: a reserve row, a rounds row that is no longer running, nothing else. */
async function killedRound(id: string, cap = 250_000, status = "abandoned") {
  assert.equal(await reserve(id, cap), true);
  await sql()`insert into rounds(id, family, status) values (${id}, 'dates', ${status}) on conflict (id) do update set status = ${status}`;
}

test("a killed round's hold is listed, and releasing it returns exactly what was reserved, once", async () => {
  await credit("k", 1_000_000, "t");
  await killedRound("r-1");
  assert.deepEqual(await getWallet(), { balance: 750_000, held: 250_000 });
  assert.deepEqual((await listStuckHolds()).map((h) => [h.round_id, h.held_micros]), [["r-1", 250_000]]);
  assert.deepEqual(await releaseStuckHold("r-1", "Aryaman"), { ok: true, releasedMicros: 250_000 });
  assert.deepEqual(await getWallet(), { balance: 1_000_000, held: 0 });
  assert.deepEqual(await listStuckHolds(), []);
  assert.equal((await releaseStuckHold("r-1", "Aryaman")).ok, false); // idempotent: a second call cannot pay out twice
  assert.deepEqual(await getWallet(), { balance: 1_000_000, held: 0 });
  const row = (await sql()`select kind, note from ledger where idem_key = 'operator_release:r-1'`) as { kind: string; note: string }[];
  assert.deepEqual(row.map((x) => [x.kind, x.note]), [["release", "released by Aryaman"]]);
});

test("the amount released is what the ledger says was reserved, never a caller-supplied figure", async () => {
  await credit("k", 1_000_000, "t");
  await killedRound("r-small", 100_000);
  await killedRound("r-big", 300_000);
  assert.equal((await releaseStuckHold("r-small", "a")).releasedMicros, 100_000);
  assert.equal((await releaseStuckHold("r-big", "a")).releasedMicros, 300_000);
  assert.deepEqual(await getWallet(), { balance: 1_000_000, held: 0 });
});

test("a round that is still running, already settled, or unknown is refused and nothing moves", async () => {
  await credit("k", 1_000_000, "t");
  await killedRound("r-running", 250_000, "running");
  assert.equal((await releaseStuckHold("r-running", "a")).ok, false);
  assert.deepEqual(await listStuckHolds(), []); // a running round is not listed either

  assert.equal(await reserve("r-settled", 250_000), true);
  assert.equal(await settle("r-settled", 250_000, 40_000), true);
  assert.equal((await releaseStuckHold("r-settled", "a")).ok, false);

  assert.equal((await releaseStuckHold("r-never", "a")).ok, false);
  // 1,000,000 - 250,000 (running, still held) - 40,000 (settled spend) = 710,000 available; only the running hold remains held
  assert.deepEqual(await getWallet(), { balance: 710_000, held: 250_000 });
});

test("a blocked round (unknown usage) is listed with its reason and can be released by a person", async () => {
  await credit("k", 1_000_000, "t");
  await killedRound("r-blocked", 250_000, "error");
  await markBlocked("r-blocked", 250_000, "usage unknown; reservation stays held");
  const [h] = await listStuckHolds();
  assert.equal(h.note, "usage unknown; reservation stays held");
  assert.equal((await releaseStuckHold("r-blocked", "a")).ok, true);
});

test("releasing one hold leaves the others held", async () => {
  await credit("k", 2_000_000, "t");
  await killedRound("r-a");
  await killedRound("r-b");
  await releaseStuckHold("r-a", "a");
  assert.deepEqual((await listStuckHolds()).map((h) => h.round_id), ["r-b"]);
  assert.deepEqual(await getWallet(), { balance: 1_750_000, held: 250_000 });
});

test("a live round is not releasable until it has finished", async () => {
  await credit("k", 1_000_000, "t");
  assert.equal(await tryStartRound("r-live", "dates"), true);
  assert.equal(await reserve("r-live", 250_000), true);
  assert.equal((await releaseStuckHold("r-live", "a")).ok, false);
  await finishRoundRow("r-live", "error", {});
  assert.equal((await releaseStuckHold("r-live", "a")).ok, true);
});

// ---------- leaked sandboxes ----------
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const nameAt = (family: string, ms: number) => `vf-${family}-${ms.toString(36)}`;
const sb = (id: string, name: string, status = "running") => ({ id, name, status });

test("only OUR running sandboxes older than six minutes are stale", () => {
  const list = [
    sb("old-dates", nameAt("dat", NOW - STALE_SANDBOX_MS - 1000)),
    sb("recent", nameAt("dat", NOW - 60_000)),
    sb("edge", nameAt("dat", NOW - STALE_SANDBOX_MS)), // exactly six minutes: not yet stale
    sb("old-audit", nameAt("aud", NOW - 3_600_000)),
    sb("destroyed", nameAt("dat", NOW - 3_600_000), "destroyed"),
    sb("not-ours", "my-own-sandbox"),
    sb("lookalike", "vf-dates-abc"),
    sb("no-name", ""),
  ];
  assert.deepEqual(staleSandboxIds(list, NOW), ["old-dates", "old-audit"]);
});

function reapDeps(opts: { running?: ReturnType<typeof sb>[]; create?: ReapDeps["create"] } = {}) {
  const log = { created: 0, destroyed: [] as string[], listed: 0 };
  const running = opts.running ?? [];
  const deps: ReapDeps = {
    create:
      opts.create ??
      (async (name) => {
        log.created++;
        if (running.length - log.destroyed.length > 0) throw new SandboxError("POST /v1/sandboxes -> 429: sandbox concurrent quota reached (1 / 1). Destroy or pause one before creating another.", 429);
        return { id: "sb-new:" + name, spawnMs: 5 };
      }),
    list: async () => {
      log.listed++;
      return running;
    },
    destroy: async (id) => void log.destroyed.push(id),
    now: () => NOW,
  };
  return { deps, log };
}

test("creating a sandbox is unchanged when there is room: no listing, no destroying", async () => {
  const { deps, log } = reapDeps();
  assert.equal((await createSandboxReaping("vf-dat-x", undefined, deps)).id, "sb-new:vf-dat-x");
  assert.deepEqual(log, { created: 1, destroyed: [], listed: 0 });
});

test("at the concurrent quota, a stale sandbox of ours is destroyed and creation is retried once", async () => {
  const { deps, log } = reapDeps({ running: [sb("leaked", nameAt("dat", NOW - 20 * 60_000))] });
  assert.equal((await createSandboxReaping("vf-dat-x", undefined, deps)).id, "sb-new:vf-dat-x");
  assert.deepEqual(log.destroyed, ["leaked"]);
  assert.equal(log.created, 2);
});

test("at the quota with a RECENT sandbox (a real round may be using it), nothing is destroyed and the error stands", async () => {
  const { deps, log } = reapDeps({ running: [sb("busy", nameAt("dat", NOW - 30_000))] });
  await assert.rejects(() => createSandboxReaping("vf-dat-x", undefined, deps), /concurrent quota/);
  assert.deepEqual(log.destroyed, []);
  assert.equal(log.created, 1);
});

test("a sandbox that is not ours is never destroyed, however old", async () => {
  const { deps, log } = reapDeps({ running: [sb("someone-elses", "prod-db-shell")] });
  await assert.rejects(() => createSandboxReaping("vf-dat-x", undefined, deps), /concurrent quota/);
  assert.deepEqual(log.destroyed, []);
});

test("other errors are not treated as a quota problem: no listing, no destroying", async () => {
  const a = reapDeps({ create: async () => { throw new SandboxError("POST /v1/sandboxes -> 500: boom", 500); } });
  await assert.rejects(() => createSandboxReaping("vf-dat-x", undefined, a.deps), /boom/);
  assert.equal(a.log.listed, 0);
  const b = reapDeps({ create: async () => { throw new SandboxError("POST /v1/sandboxes -> 429: rate limit exceeded", 429); } });
  await assert.rejects(() => createSandboxReaping("vf-dat-x", undefined, b.deps), /rate limit/); // a 429, but not the concurrency message
  assert.equal(b.log.listed, 0);
});

test("if the retry still fails, the error is surfaced (one retry only)", async () => {
  let creates = 0;
  const { deps } = reapDeps({
    create: async () => { creates++; throw new SandboxError("POST /v1/sandboxes -> 429: sandbox concurrent quota reached", 429); },
    running: [sb("leaked", nameAt("dat", NOW - 3_600_000))],
  });
  await assert.rejects(() => createSandboxReaping("vf-dat-x", undefined, deps), /concurrent quota/);
  assert.equal(creates, 2);
});
