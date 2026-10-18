// Run: npx tsx --test tests/db.test.ts
// Runs the REAL SQL from src/lib/db.ts against an in-process Postgres (PGlite): no network, no production data.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  __setSqlForTests, credit, ensureSchema, getActive, getHeldoutSet, getWallet, insertTool, LIFETIME_TOPUP_CAP_MICROS,
  markBlocked, recentLedger, reserve, review, seedHeldoutSet, settle, sql, tryStartRound,
} from "../src/lib/db";
import { sha256 } from "../src/lib/bench/cases";

let pg: PGlite;
before(async () => {
  pg = new PGlite();
  __setSqlForTests(async (strings, ...values) => {
    const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""), "");
    const r = await pg.query(text, values as unknown[]);
    return r.rows as unknown[];
  });
});
after(async () => {
  __setSqlForTests(null);
  await pg.close();
});
beforeEach(async () => {
  await pg.exec("drop schema public cascade; create schema public;");
  __setSqlForTests((await import("../src/lib/db")).sql === undefined ? null : (null as never)); // reset schemaReady below
  __setSqlForTests(async (strings, ...values) => {
    const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""), "");
    return (await pg.query(text, values as unknown[])).rows as unknown[];
  });
  await ensureSchema();
});

const proposal = (id: string, code: string) => ({
  id, family: "dates" as const, version: 1, code, sha: sha256(code), status: "proposed" as const,
  visible_count: 12, heldout_count: 10, heldout_pass: Array(10).fill(true), round_id: "r1", rationale: "x", gate: { passed: true, reasons: [] },
});

test("credit is idempotent per key and respects the lifetime cap", async () => {
  assert.equal(await credit("k1", 5_000_000, "t"), true);
  assert.equal(await credit("k1", 5_000_000, "t"), false); // replay is a no-op
  assert.equal((await getWallet()).balance, 5_000_000);
  assert.equal(await credit("k2", LIFETIME_TOPUP_CAP_MICROS, "t"), false); // would exceed the cap
  assert.equal((await getWallet()).balance, 5_000_000);
});

test("reserve refuses without funds and changes nothing", async () => {
  assert.equal(await reserve("r-a", 250_000), false);
  assert.deepEqual(await getWallet(), { balance: 0, held: 0 });
  assert.equal((await recentLedger()).length, 0);
});

test("reserve then settle moves exactly the actual cost and releases the rest, once", async () => {
  await credit("k1", 1_000_000, "t");
  assert.equal(await reserve("r-b", 250_000), true);
  assert.deepEqual(await getWallet(), { balance: 750_000, held: 250_000 });
  assert.equal(await settle("r-b", 250_000, 30_000), true);
  assert.deepEqual(await getWallet(), { balance: 970_000, held: 0 });
  assert.equal(await settle("r-b", 250_000, 30_000), false); // second settle is a no-op
  assert.deepEqual(await getWallet(), { balance: 970_000, held: 0 });
  const kinds = (await recentLedger(20)).map((l) => l.kind).sort();
  assert.deepEqual(kinds, ["release", "reserve", "settle", "topup"]);
});

test("an overrun is refused, never clipped; a blocked round keeps its hold", async () => {
  await credit("k1", 1_000_000, "t");
  await reserve("r-c", 250_000);
  assert.equal(await settle("r-c", 250_000, 300_000), false);
  assert.deepEqual(await getWallet(), { balance: 750_000, held: 250_000 });
  await markBlocked("r-c", 250_000, "usage unknown");
  await markBlocked("r-c", 250_000, "usage unknown"); // idempotent
  assert.equal((await recentLedger(20)).filter((l) => l.kind === "blocked_unsettled").length, 1);
  assert.deepEqual(await getWallet(), { balance: 750_000, held: 250_000 });
});

test("approval is bound to the code hash and promotion is atomic", async () => {
  const active = await getActive("dates"); // creates v0 active
  const code = "def normalize(raw):\n    return raw\n";
  await insertTool(proposal("t-1", code));
  assert.deepEqual(await review("t-1", "approve", "0000"), { ok: false, error: "hash mismatch: the code changed after review" });
  assert.equal((await getActive("dates")).id, active.id); // nothing changed
  assert.deepEqual(await review("t-1", "approve", sha256(code)), { ok: true });
  assert.equal((await getActive("dates")).id, "t-1");
  const old = (await sql()`select status from tools where id = ${active.id}`) as { status: string }[];
  assert.equal(old[0].status, "superseded");
  assert.equal(((await sql()`select count(*) as n from approvals`) as { n: number }[])[0].n, 1);
  assert.equal((await review("t-1", "approve", sha256(code))).ok, false); // cannot approve twice
});

test("an edited candidate cannot be approved with the old hash", async () => {
  await getActive("dates");
  const code = "def normalize(raw):\n    return raw\n";
  await insertTool(proposal("t-2", code));
  await sql()`update tools set code = ${code + "# tampered"} where id = 't-2'`;
  const r = await review("t-2", "approve", sha256(code));
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /hash mismatch/);
});

test("reject marks the tool rejected and leaves the active tool alone", async () => {
  const active = await getActive("dates");
  const code = "def normalize(raw):\n    return raw\n";
  await insertTool(proposal("t-3", code));
  assert.deepEqual(await review("t-3", "reject", sha256(code)), { ok: true });
  assert.equal((await getActive("dates")).id, active.id);
  assert.equal(((await sql()`select status from tools where id = 't-3'`) as { status: string }[])[0].status, "rejected");
});

test("only one round can hold the running slot; finishing frees it", async () => {
  assert.equal(await tryStartRound("r-1", "dates"), true);
  assert.equal(await tryStartRound("r-2", "money"), false);
  await sql()`update rounds set status = 'done' where id = 'r-1'`;
  assert.equal(await tryStartRound("r-2", "money"), true);
});

test("a stale running round is expired so a crash cannot block forever", async () => {
  assert.equal(await tryStartRound("r-old", "dates"), true);
  await sql()`update rounds set created_at = now() - interval '10 minutes' where id = 'r-old'`;
  assert.equal(await tryStartRound("r-new", "dates"), true);
  assert.equal(((await sql()`select status from rounds where id = 'r-old'`) as { status: string }[])[0].status, "abandoned");
});

test("changing the held-out set clears old per-case pass vectors; unchanged seeds do not", async () => {
  const active = await getActive("dates");
  await sql()`update tools set heldout_pass_json = '[true]', heldout_count = 1 where id = ${active.id}`;
  const cases = [{ input: "a", expected: "1" }];
  assert.equal((await seedHeldoutSet("dates", cases)).changed, true);
  assert.equal((await getActive("dates")).heldout_pass, null);
  await sql()`update tools set heldout_pass_json = '[true]' where id = ${active.id}`;
  assert.equal((await seedHeldoutSet("dates", cases)).changed, false);
  assert.deepEqual((await getActive("dates")).heldout_pass, [true]);
  assert.equal((await getHeldoutSet("dates"))?.cases.length, 1);
});
