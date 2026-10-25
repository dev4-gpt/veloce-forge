// Run: npx tsx --test tests/preflight.test.ts
// The deploy preflight: its verdict rules, and a proof that gathering database facts is read-only (it never creates or changes anything).
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { __setSqlForTests, createReviewer, credit, ensureSchema, seedHeldoutSet, sql } from "../src/lib/db";
import { evaluate, FAMILIES, gatherDb, gatherEnv, gatherFiles, type DbFacts, type EnvFacts, type FileFacts } from "../src/lib/preflight";

const goodEnv = (): EnvFacts => ({
  present: { CREATEOS_SANDBOX_API_KEY: true, GEMINI_API_KEY: true, NEON_POSTGRES_CONNECTION_STRING: true, DATABASE_URL: false, STRIPE_SECRET_KEY: true, STRIPE_WEBHOOK_SECRET: true, DEMO_PASSCODE: true, REPORT_SIGNING_KEY: true, OPENROUTER_API_KEY: true, NVIDIA_API_KEY: false },
  stripeKeyIsTest: true, passcodeLength: 24, signingKey: "valid", cardPolicy: null, providerCount: 2, llmWarnings: [],
});
const sets = (n = 10) => ({ ...Object.fromEntries(FAMILIES.map((f) => [f, n])), e2e: 13, ...Object.fromEntries(FAMILIES.map((f) => [`audit:${f}`, n])) });
const goodDb = (): DbFacts => ({
  reachable: true, tables: ["rounds"], runningRounds: 0, reviewers: { total: 2, roles: { operator: 1, reviewer: 1 } }, heldoutSets: sets(), heldoutShas: Object.fromEntries(Object.keys(sets()).map((k) => [k, `sha-${k}`])), tools: [],
  wallet: { balance: 4_000_000, held: 0 }, chainLength: 3, openHolds: 0,
});
const goodFiles = (): FileFacts => ({ heldout: Object.fromEntries(FAMILIES.map((f) => [f, 10])), audit: Object.fromEntries(FAMILIES.map((f) => [f, 10])), overlaps: [] });
const levels = (cs: ReturnType<typeof evaluate>, level: string) => cs.filter((c) => c.level === level).map((c) => c.item);

test("a fully prepared deployment has no blocks and no warnings", () => {
  const cs = evaluate(goodEnv(), goodDb(), goodFiles());
  assert.deepEqual(levels(cs, "block"), []);
  assert.deepEqual(levels(cs, "warn"), []);
});

test("missing required environment variables, a non-test Stripe key and an invalid signing key all block", () => {
  const env = goodEnv();
  env.present.GEMINI_API_KEY = false;
  env.present.NEON_POSTGRES_CONNECTION_STRING = false;
  env.stripeKeyIsTest = false;
  env.signingKey = "invalid";
  const blocks = levels(evaluate(env, goodDb(), goodFiles()), "block");
  for (const i of ["GEMINI_API_KEY", "database connection string", "Stripe key mode", "REPORT_SIGNING_KEY"]) assert.ok(blocks.includes(i), `${i} should block: ${blocks}`);
});

test("optional hardening is a warning, not a block: unsigned chain, short passcode, one model provider, no webhook secret", () => {
  const env = goodEnv();
  env.signingKey = "absent";
  env.passcodeLength = 6;
  env.providerCount = 1;
  env.present.STRIPE_WEBHOOK_SECRET = false;
  const cs = evaluate(env, goodDb(), goodFiles());
  assert.deepEqual(levels(cs, "block"), []);
  for (const i of ["REPORT_SIGNING_KEY", "DEMO_PASSCODE", "model providers", "STRIPE_WEBHOOK_SECRET"]) assert.ok(levels(cs, "warn").includes(i), i);
});

test("unseeded held-out sets: a warning when the local file has them, a block when nothing has them", () => {
  const db = goodDb();
  db.heldoutSets = {};
  assert.ok(levels(evaluate(goodEnv(), db, goodFiles()), "warn").includes("held-out sets in database"));
  const noFile = goodFiles();
  noFile.heldout = null;
  const cs = evaluate(goodEnv(), db, noFile);
  assert.ok(levels(cs, "block").includes("held-out sets"));
  assert.ok(levels(cs, "block").includes("sealed cross-pillar set (e2e)"));
});

test("a local held-out file with a short family blocks, and audit/held-out overlap blocks", () => {
  const f = goodFiles();
  f.heldout!.money = 3;
  f.overlaps = ["dates", "dates"];
  const blocks = levels(evaluate(goodEnv(), goodDb(), f), "block");
  assert.ok(blocks.includes("private/heldout.json"));
  assert.ok(blocks.includes("audit/held-out overlap"));
});

test("reviewers: none is demo mode (warn); roles that cannot both run and approve would lock the system (block); one identity cannot promote anything (warn)", () => {
  const none = goodDb();
  none.reviewers = { total: 0, roles: {} };
  assert.ok(levels(evaluate(goodEnv(), none, goodFiles()), "warn").includes("reviewers"));
  const onlyOps = goodDb();
  onlyOps.reviewers = { total: 2, roles: { operator: 2 } };
  assert.ok(levels(evaluate(goodEnv(), onlyOps, goodFiles()), "block").includes("reviewers"));
  const onlyReviewers = goodDb();
  onlyReviewers.reviewers = { total: 2, roles: { reviewer: 2 } };
  assert.ok(levels(evaluate(goodEnv(), onlyReviewers, goodFiles()), "block").includes("reviewers"));
  const one = goodDb();
  one.reviewers = { total: 1, roles: { admin: 1 } };
  const cs = evaluate(goodEnv(), one, goodFiles());
  assert.deepEqual(levels(cs, "block"), []);
  assert.ok(levels(cs, "warn").includes("reviewers"));
});

test("pending proposals and tools promoted under the old held-out regime are called out", () => {
  const db = goodDb();
  db.tools = [
    { id: "t-money-r-1", family: "money", status: "proposed", heldoutCount: 10, heldoutSha: null },
    { id: "t-dates-r-2", family: "dates", status: "active", heldoutCount: 10, heldoutSha: null },
    { id: "t-dates-v0", family: "dates", status: "superseded", heldoutCount: null, heldoutSha: null },
    { id: "t-money-v0", family: "money", status: "active", heldoutCount: null, heldoutSha: null },
  ];
  const cs = evaluate(goodEnv(), db, goodFiles());
  assert.match(cs.find((c) => c.item === "pending proposals")!.detail, /t-money-r-1/);
  const promoted = cs.find((c) => c.item === "tools promoted under the old regime")!;
  assert.match(promoted.detail, /t-dates-r-2/);
  assert.doesNotMatch(promoted.detail, /v0/); // baselines are not "promoted"
});

test("pending proposals: ones scored against another set (or unrecorded) are named as unapprovable, a current one only as pending", () => {
  const db = goodDb();
  db.tools = [
    { id: "t-old", family: "money", status: "proposed", heldoutCount: 10, heldoutSha: "sha-money-OLD" },
    { id: "t-unrecorded", family: "dates", status: "proposed", heldoutCount: 10, heldoutSha: null },
    { id: "t-fresh", family: "durations", status: "proposed", heldoutCount: 10, heldoutSha: "sha-durations" },
  ];
  const d = evaluate(goodEnv(), db, goodFiles()).find((c) => c.item === "pending proposals")!;
  assert.match(d.detail, /t-old, t-unrecorded .*refused/);
  assert.doesNotMatch(d.detail.split("refused")[0], /t-fresh/);
  db.tools = [db.tools[2]];
  const only = evaluate(goodEnv(), db, goodFiles()).find((c) => c.item === "pending proposals")!;
  assert.match(only.detail, /t-fresh.*await review/);
  assert.doesNotMatch(only.detail, /not scored/);
});

test("wallet: held money and a low balance warn; an unreachable database blocks", () => {
  const held = goodDb();
  held.wallet = { balance: 1_000_000, held: 250_000 };
  assert.ok(levels(evaluate(goodEnv(), held, goodFiles()), "warn").includes("wallet"));
  const low = goodDb();
  low.wallet = { balance: 100_000, held: 0 };
  assert.ok(levels(evaluate(goodEnv(), low, goodFiles()), "warn").includes("wallet"));
  const down: DbFacts = { ...goodDb(), reachable: false, error: "connection refused" };
  assert.ok(levels(evaluate(goodEnv(), down, goodFiles()), "block").includes("database"));
});

test("gatherEnv reports only presence and validity, never values", () => {
  const k = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const e = gatherEnv({ GEMINI_API_KEY: "SECRET-VALUE", STRIPE_SECRET_KEY: "sk_test_abc", DEMO_PASSCODE: "0123456789", REPORT_SIGNING_KEY: k, CARD_CAPTURE_POLICY: "on_green" } as unknown as NodeJS.ProcessEnv);
  assert.equal(e.present.GEMINI_API_KEY, true);
  assert.equal(e.stripeKeyIsTest, true);
  assert.equal(e.signingKey, "valid");
  assert.equal(e.passcodeLength, 10);
  assert.ok(!JSON.stringify(e).includes("SECRET-VALUE") && !JSON.stringify(e).includes(k));
  assert.equal(gatherEnv({ STRIPE_SECRET_KEY: "sk_live_abc" } as unknown as NodeJS.ProcessEnv).stripeKeyIsTest, false);
  assert.equal(gatherEnv({ REPORT_SIGNING_KEY: "not-a-key" } as unknown as NodeJS.ProcessEnv).signingKey, "invalid");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  assert.equal(gatherEnv({ REPORT_SIGNING_KEY: rsa } as unknown as NodeJS.ProcessEnv).signingKey, "invalid"); // only Ed25519 is accepted
  assert.equal(gatherEnv({} as unknown as NodeJS.ProcessEnv).stripeKeyIsTest, null);
});

test("gatherFiles counts cases and detects audit inputs shared with the held-out file", () => {
  const f = gatherFiles({ dates: [{ input: "a" }, { input: "b" }], money: [{ input: "x" }] }, { dates: [{ input: "b" }, { input: "c" }], money: [{ input: "y" }] });
  assert.deepEqual(f.heldout, { dates: 2, money: 1 });
  assert.deepEqual(f.overlaps, ["dates"]);
  assert.deepEqual(gatherFiles(null, null), { heldout: null, audit: null, overlaps: [] });
});

// ---------- the database gatherer is read-only ----------
let pg: PGlite;
before(async () => {
  pg = new PGlite();
});
after(async () => {
  __setSqlForTests(null);
  await pg.close();
});
const bind = () =>
  __setSqlForTests(async (strings, ...values) => {
    const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""), "");
    return (await pg.query(text, values as unknown[])).rows as unknown[];
  });
const snapshot = async () => ((await pg.query("select table_name from information_schema.tables where table_schema = 'public' order by 1")).rows as { table_name: string }[]).map((r) => r.table_name);

test("gatherDb on an EMPTY database reports it and creates nothing (it must never migrate production)", async () => {
  await pg.exec("drop schema public cascade; create schema public;");
  bind();
  const f = await gatherDb(sql());
  assert.equal(f.reachable, true);
  assert.deepEqual(f.tables, []);
  assert.deepEqual(await snapshot(), []);
  assert.equal(f.reviewers, null);
  assert.equal(f.chainLength, null);
});

test("gatherDb reads real state and changes nothing", async () => {
  await pg.exec("drop schema public cascade; create schema public;");
  bind();
  await ensureSchema();
  await credit("k", 1_000_000, "t");
  await seedHeldoutSet("dates", Array.from({ length: 6 }, (_, i) => ({ input: `i${i}`, expected: "x" })));
  await createReviewer("Ann", "operator");
  await createReviewer("Bo", "reviewer");
  await sql()`insert into rounds(id, family, status) values ('r-stale', 'dates', 'running')`;
  const state = async () => JSON.stringify([await snapshot(), (await pg.query("select count(*) n from rounds")).rows, (await pg.query("select * from wallet")).rows]);
  const before = await state();
  const f = await gatherDb(sql());
  assert.equal(await state(), before);
  assert.equal(f.runningRounds, 1);
  assert.deepEqual(f.reviewers, { total: 2, roles: { operator: 1, reviewer: 1 } });
  assert.equal(f.heldoutSets.dates, 6);
  assert.deepEqual(f.wallet, { balance: 1_000_000, held: 0 });
  assert.equal(f.chainLength, 0);
  assert.equal(f.openHolds, 0);
});

test("gatherDb works on a database from before heldout_sha existed (every proposal reads as unrecorded)", async () => {
  await pg.exec("drop schema public cascade; create schema public;");
  await pg.exec("create table tools (id text primary key, family text not null, status text not null, heldout_count int)");
  await pg.exec("insert into tools values ('t-p', 'money', 'proposed', 10)");
  bind();
  const f = await gatherDb(sql());
  assert.equal(f.error, undefined);
  assert.deepEqual(f.tools, [{ id: "t-p", family: "money", status: "proposed", heldoutCount: 10, heldoutSha: null }]);
});

test("gatherDb reports the stored set commitments and each tool's recorded one", async () => {
  await pg.exec("drop schema public cascade; create schema public;");
  bind();
  await ensureSchema();
  const { sha } = await seedHeldoutSet("dates", Array.from({ length: 6 }, (_, i) => ({ input: `i${i}`, expected: "x" })));
  await sql()`insert into tools(id, family, version, code, sha, status, heldout_sha) values ('t-d', 'dates', 1, 'c', 's', 'proposed', ${sha})`;
  const f = await gatherDb(sql());
  assert.equal(f.heldoutShas.dates, sha);
  assert.equal(f.tools[0].heldoutSha, sha);
});

test("gatherDb reports an unreachable database instead of throwing", async () => {
  const f = await gatherDb(async () => {
    throw new Error("connection refused");
  });
  assert.equal(f.reachable, false);
  assert.match(f.error ?? "", /connection refused/);
});

test("provider warnings reach the deploy check, and a typo in LLM_PROVIDERS is flagged", () => {
  const env = gatherEnv({ LLM_PROVIDERS: "grok,gemini", GEMINI_API_KEY: "g", GROQ_API_KEY: "k", GROQ_MODEL: "m" } as unknown as NodeJS.ProcessEnv);
  assert.ok(env.llmWarnings.some((w) => w.includes('Did you mean "groq"')));
  const warns = evaluate(env, goodDb(), goodFiles()).filter((c) => c.item === "LLM_PROVIDERS");
  assert.ok(warns.length >= 1 && warns.every((c) => c.level === "warn"));
  assert.deepEqual(gatherEnv({ LLM_PROVIDERS: "groq,gemini", GEMINI_API_KEY: "g", GROQ_API_KEY: "k", GROQ_MODEL: "m" } as unknown as NodeJS.ProcessEnv).llmWarnings, []);
});
