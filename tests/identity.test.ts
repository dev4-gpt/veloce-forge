// Run: npx tsx --test tests/identity.test.ts
// Real SQL against in-process Postgres (PGlite): reviewer tokens, roles, no-downgrade rule, separation of duties.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { authenticate, requireRole } from "../src/lib/auth";
import { __setSqlForTests, createReviewer, ensureSchema, getActive, insertTool, review, seedHeldoutSet, sql, tryStartRound } from "../src/lib/db";
import { sha256 } from "../src/lib/bench/cases";

let pg: PGlite;
const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""), "");
  return (await pg.query(text, values as unknown[])).rows as unknown[];
};
before(() => {
  pg = new PGlite();
});
after(async () => {
  __setSqlForTests(null);
  await pg.close();
});
beforeEach(async () => {
  await pg.exec("drop schema public cascade; create schema public;");
  __setSqlForTests(tag);
  await ensureSchema();
});

const env = { DEMO_PASSCODE: "shared-secret" } as unknown as NodeJS.ProcessEnv;
const req = (h: Record<string, string> = {}) => new Request("http://x/api", { method: "POST", headers: h });
const CODE = "def normalize(raw):\n    return raw\n";
const HELD = [{ input: "a", expected: "1" }];
const tool = (id: string, roundId: string) => ({
  id, family: "dates" as const, version: 1, code: CODE, sha: sha256(CODE), status: "proposed" as const,
  visible_count: 1, heldout_count: 1, heldout_pass: [true], heldout_sha: sha256(JSON.stringify(HELD)), round_id: roundId, rationale: "x", gate: { passed: true, reasons: [] },
});

test("demo mode: with no reviewers, the shared passcode works and maps to a pseudo identity", async () => {
  const ok = await authenticate(req({ "x-demo-passcode": "shared-secret" }), env);
  assert.equal(ok.ok && ok.identity.id, "shared-passcode");
  assert.equal((await authenticate(req({ "x-demo-passcode": "nope" }), env)).ok, false);
  assert.equal((await authenticate(req(), env)).ok, false);
});

test("a reviewer token authenticates as that named person with their role", async () => {
  const { id, token } = await createReviewer("Ana", "reviewer");
  const a = await authenticate(req({ "x-reviewer-token": token }), env);
  assert.equal(a.ok && a.identity.id, id);
  assert.equal(a.ok && a.identity.role, "reviewer");
  assert.equal(a.ok && a.identity.name, "Ana");
});

test("tokens are stored hashed, never in plain text", async () => {
  const { token } = await createReviewer("Ben", "operator");
  const rows = (await sql()`select token_hash from reviewers`) as { token_hash: string }[];
  assert.equal(rows[0].token_hash, sha256(token));
  assert.notEqual(rows[0].token_hash, token);
});

test("no downgrade: once any reviewer exists, the shared passcode stops working", async () => {
  await createReviewer("Ana", "admin");
  const a = await authenticate(req({ "x-demo-passcode": "shared-secret" }), env);
  assert.equal(a.ok, false);
  const b = await authenticate(req({ "x-demo-passcode": "shared-secret", "x-reviewer-token": "wrong" }), env);
  assert.equal(b.ok, false);
});

test("a disabled reviewer's token is refused", async () => {
  const { id, token } = await createReviewer("Cy", "reviewer");
  await createReviewer("Dee", "admin"); // keep token mode on
  await sql()`update reviewers set disabled = true where id = ${id}`;
  assert.equal((await authenticate(req({ "x-reviewer-token": token }), env)).ok, false);
});

test("roles are enforced: an operator cannot review, a reviewer cannot run rounds", async () => {
  const op = await createReviewer("Op", "operator");
  const rv = await createReviewer("Rv", "reviewer");
  const asOp = await requireRole(req({ "x-reviewer-token": op.token }), ["reviewer", "admin"]);
  assert.equal(asOp instanceof Response && asOp.status, 403);
  const asRv = await requireRole(req({ "x-reviewer-token": rv.token }), ["operator", "admin"]);
  assert.equal(asRv instanceof Response && asRv.status, 403);
  const okRv = await requireRole(req({ "x-reviewer-token": rv.token }), ["reviewer", "admin"]);
  assert.equal("identity" in okRv && okRv.identity.name, "Rv");
});

test("separation of duties: whoever started the round cannot approve its tool; another reviewer can", async () => {
  const starter = await createReviewer("Starter", "admin");
  const other = await createReviewer("Other", "reviewer");
  await getActive("dates");
  await seedHeldoutSet("dates", HELD);
  assert.equal(await tryStartRound("r-sod", "dates", starter.id), true);
  await insertTool(tool("t-sod", "r-sod"));
  const self = await review("t-sod", "approve", sha256(CODE), starter.id);
  assert.equal(self.ok, false);
  assert.match(self.error ?? "", /separation of duties/);
  assert.equal((await getActive("dates")).id !== "t-sod", true);
  const ok = await review("t-sod", "approve", sha256(CODE), other.id);
  assert.deepEqual(ok, { ok: true });
  const ap = (await sql()`select reviewer_id from approvals where tool_id = 't-sod'`) as { reviewer_id: string }[];
  assert.equal(ap[0].reviewer_id, other.id); // who approved is recorded
});

test("the shared passcode identity records no reviewer id (legacy demo mode)", async () => {
  await getActive("dates");
  await tryStartRound("r-demo", "dates", "shared-passcode");
  await seedHeldoutSet("dates", HELD);
  await insertTool(tool("t-demo", "r-demo"));
  assert.deepEqual(await review("t-demo", "approve", sha256(CODE), null), { ok: true });
  const ap = (await sql()`select reviewer_id from approvals where tool_id = 't-demo'`) as { reviewer_id: string | null }[];
  assert.equal(ap[0].reviewer_id, null);
});
