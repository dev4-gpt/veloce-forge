// Run: npx tsx --test tests/evidence.test.ts
// Covers the hash chain (src/lib/evidence.ts), its database store (real SQL on PGlite) and the standalone offline verifier
// (scripts/verify-report.mjs). Every tamper case must be caught by BOTH implementations.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { __setSqlForTests, ensureSchema, sql } from "../src/lib/db";
import { appendReport, readChain } from "../src/lib/chainStore";
import {
  canonical, entryHash, GENESIS, loadSigner, makeEntry, sha256hex, summariseEvents, verifyChain,
  type AuditBody, type DecisionBody, type Entry, type ReportBody, type RoundBody,
} from "../src/lib/evidence";
// @ts-ignore plain .mjs on purpose: the offline verifier has no build step and no TypeScript
import { verify as offlineVerifyRaw } from "../scripts/verify-report.mjs";
const offlineVerify = offlineVerifyRaw as (e: Entry[], o?: { pubkey?: string; head?: string; margin?: number }) => { ok: boolean; problems: string[] };

const CODE = "def normalize(raw):\n    return raw.strip()\n";

const round = (over: Partial<RoundBody> = {}): RoundBody => ({
  kind: "round", roundId: "r-1", family: "dates", pillar: "Command", startedBy: "u-op", status: "proposed", toolId: "t-dates-r-1",
  candidate: { sha: sha256hex(CODE), code: CODE }, visible: { current: 8, candidate: 12, total: 12 },
  heldout: { current: 4, candidate: 10, total: 10 }, heldoutCommitment: "c".repeat(64), cross: null,
  gate: { passed: true, reasons: [] }, egressBlocked: true, astOk: true, sandboxId: "sb-1",
  usage: { tokensIn: 100, tokensOut: 50, execMs: 900 }, costMicros: 40_000, settlement: "settled", at: "2026-10-17T20:00:00.000Z", ...over,
});
const decision = (over: Partial<DecisionBody> = {}): DecisionBody => ({
  kind: "decision", toolId: "t-dates-r-1", family: "dates", decision: "approve", shaAtDecision: sha256hex(CODE), reviewerId: "u-rev", at: "2026-10-17T20:05:00.000Z", ...over,
});

function chain(bodies: ReportBody[], signer: ReturnType<typeof loadSigner> = null): Entry[] {
  const out: Entry[] = [];
  for (const b of bodies) out.push(makeEntry(out.length + 1, out.length ? out[out.length - 1].hash : GENESIS, b, signer));
  return out;
}
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

function newKey() {
  const k = generateKeyPairSync("ed25519");
  const priv = k.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const pub = k.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { signer: loadSigner({ REPORT_SIGNING_KEY: priv } as unknown as NodeJS.ProcessEnv)!, pub };
}

/** Both implementations must agree on pass/fail and on the exact problems; a failing chain must mention `needle`. */
function both(es: Entry[], opts: { pubkey?: string; head?: string } = {}, needle?: string) {
  const a = verifyChain(es, { publicKeyB64: opts.pubkey, expectHead: opts.head });
  const b = offlineVerify(es, opts);
  assert.equal(a.ok, b.ok, `implementations disagree: server=${JSON.stringify(a.problems)} offline=${JSON.stringify(b.problems)}`);
  assert.deepEqual(a.problems, b.problems);
  if (needle) assert.ok(a.problems.some((p) => p.includes(needle)), `expected a problem containing "${needle}", got ${JSON.stringify(a.problems)}`);
  return a;
}

// ---------- canonical form ----------
test("canonical JSON ignores key order and drops undefined, and refuses non-finite numbers", () => {
  assert.equal(canonical({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } }), canonical({ a: { c: null, d: [3, { x: 2, y: 1 }] }, b: 1 }));
  assert.equal(canonical({ a: 1, b: undefined }), '{"a":1}');
  assert.throws(() => canonical({ a: NaN }));
  assert.throws(() => canonical({ a: Infinity }));
});

test("entry hash covers seq, prev and body", () => {
  const base = entryHash(1, GENESIS, { a: 1 });
  assert.notEqual(base, entryHash(2, GENESIS, { a: 1 }));
  assert.notEqual(base, entryHash(1, "1".repeat(64), { a: 1 }));
  assert.notEqual(base, entryHash(1, GENESIS, { a: 2 }));
});

// ---------- a good chain ----------
test("a normal round plus its approval verifies in both implementations, signed and unsigned", () => {
  const good = chain([round(), decision()]);
  assert.equal(both(good).ok, true);
  assert.equal(both(good).signed, "none");
  const { signer, pub } = newKey();
  const r = both(chain([round(), decision()], signer), { pubkey: pub });
  assert.equal(r.ok, true);
  assert.equal(r.signed, "all");
});

test("rejected, blocked and errored rounds are valid entries and need no approval", () => {
  const es = chain([
    round({ roundId: "r-a", toolId: "t-a", status: "rejected", gate: { passed: false, reasons: ["x"] }, heldout: { current: 4, candidate: 4, total: 10 } }),
    round({ roundId: "r-b", toolId: null, candidate: null, status: "error", settlement: "released", costMicros: 0 }),
    round({ roundId: "r-c", toolId: "t-c", status: "blocked_unsettled", settlement: "blocked_unsettled", costMicros: null }),
  ]);
  assert.equal(both(es).ok, true);
});

// ---------- tampering ----------
test("editing a recorded score inside an entry is detected", () => {
  const es = chain([round(), decision()]);
  (es[0].body as RoundBody).visible = { current: 1, candidate: 12, total: 12 };
  both(es, {}, "edited");
});

test("editing the candidate code is detected", () => {
  const es = chain([round(), decision()]);
  (es[0].body as RoundBody).candidate!.code += "\n# backdoor\n";
  both(es, {}, "edited");
});

test("editing code and re-hashing only that entry breaks the link to the next entry", () => {
  const es = chain([round(), decision()]);
  const b = es[0].body as RoundBody;
  b.candidate = { code: CODE + "# x\n", sha: sha256hex(CODE + "# x\n") };
  es[0].hash = entryHash(1, GENESIS, b);
  both(es, {}, "prev hash does not match");
});

test("removing an entry from the middle, or reordering entries, is detected", () => {
  const es = chain([round({ roundId: "r-1" }), round({ roundId: "r-2", toolId: "t-2" }), round({ roundId: "r-3", toolId: "t-3" })]);
  both([es[0], es[2]], {}, "not contiguous");
  both([es[1], es[0], es[2]], {}, "not contiguous");
});

test("dropping the newest entries is only detectable with a head hash you saved earlier", () => {
  const es = chain([round(), decision()]);
  const savedHead = es[1].hash;
  const truncated = es.slice(0, 1);
  assert.equal(both(truncated).ok, true); // honest limit: a shorter chain is still a valid chain
  both(truncated, { head: savedHead }, "expected head hash is not in this chain");
  assert.equal(both(es, { head: es[0].hash }).ok, true); // a chain that extends the saved head is fine
});

test("a forger who rewrites the WHOLE chain passes unsigned checks, but not a pinned key", () => {
  const { signer, pub } = newKey();
  const honest = chain([round(), decision()], signer);
  const lie = clone(honest.map((e) => e.body));
  const cheat = "def normalize(raw):\n    return 'cheat'\n";
  (lie[0] as RoundBody).candidate = { code: cheat, sha: sha256hex(cheat) };
  (lie[1] as DecisionBody).shaAtDecision = sha256hex(cheat);
  const forged = chain(lie as ReportBody[], null); // forger has the database but not the signing key
  assert.equal(both(forged).ok, true, "documented limit: unsigned chains prove consistency only");
  both(forged, { pubkey: pub }, "unsigned, but a public key was pinned");
  // and a forger with their OWN key cannot satisfy the pinned one
  both(chain(lie as ReportBody[], newKey().signer), { pubkey: pub }, "signature does not verify");
});

test("changing a signed entry's content while keeping its signature is detected even without pinning", () => {
  const { signer } = newKey();
  const es = chain([round(), decision()], signer);
  (es[0].body as RoundBody).costMicros = 1;
  both(es, {}, "edited");
});

// ---------- the promotion rules recomputed from the record ----------
test("a 'proposed' round whose own numbers do not satisfy the gate is flagged", () => {
  both(chain([round({ heldout: { current: 4, candidate: 5, total: 10 } })]), {}, "did not improve by 2");
  both(chain([round({ visible: { current: 12, candidate: 11, total: 12 } })]), {}, "visible score dropped");
  both(chain([round({ egressBlocked: null })]), {}, "outbound access was not proven blocked");
  both(chain([round({ astOk: false })]), {}, "syntax-tree screen did not pass");
  both(chain([round({ gate: { passed: false, reasons: ["r"] } })]), {}, "gate did not pass");
  both(chain([round({ cross: { partner: "govern", current: 9, candidate: 8, total: 13 } })]), {}, "cross-pillar");
  both(chain([round({ costMicros: null })]), {}, "settled with a known cost");
  both(chain([round({ settlement: "blocked_unsettled" })]), {}, "settled with a known cost");
});

test("a round id cannot be recorded twice", () => {
  both(chain([round(), round({ toolId: "t-other" })]), {}, "recorded twice");
});

// ---------- decisions ----------
test("an approval must follow a proposed round with the same hash", () => {
  both(chain([decision()]), {}, "no earlier round entry");
  both(chain([round(), decision({ shaAtDecision: sha256hex("something else") })]), {}, "differs from the code the round produced");
  both(chain([round({ status: "rejected", gate: { passed: false, reasons: [] } }), decision()]), {}, 'not "proposed"');
});

test("a tool cannot be decided twice, and the starter cannot review their own round", () => {
  both(chain([round(), decision(), decision({ decision: "reject" })]), {}, "decided more than once");
  both(chain([round({ startedBy: "u-op" }), decision({ reviewerId: "u-op" })]), {}, "separation of duties");
  // demo mode: the shared passcode is one pseudo identity and is exempt, as in the database rule
  assert.equal(both(chain([round({ startedBy: "shared-passcode" }), decision({ reviewerId: "shared-passcode" })])).ok, true);
});


// ---------- fresh audits and revocation ----------
const audit = (over: Partial<AuditBody> = {}): AuditBody => ({
  kind: "audit", toolId: "t-dates-r-1", family: "dates", auditSetSha: "a".repeat(64), candidate: { pass: 8, total: 10 },
  previous: { toolId: "t-dates-v0", pass: 5, total: 10 }, heldout: { pass: 9, total: 10 }, passed: true, reasons: [], egressBlocked: true,
  sandboxId: "sb-2", costMicros: 20_000, at: "2026-10-17T20:10:00.000Z", ...over,
});

test("a promoted tool's audit and a later revoke form a valid chain", () => {
  const es = chain([round(), decision(), audit(), decision({ decision: "revoke", reviewerId: "u-rev2" })]);
  assert.equal(both(es).ok, true);
});

test("a failed audit may record numbers that would not pass; a passed audit may not", () => {
  const bad = { candidate: { pass: 6, total: 10 }, previous: { toolId: "t-dates-v0", pass: 6, total: 10 }, heldout: { pass: 10, total: 10 } };
  assert.equal(both(chain([round(), decision(), audit({ ...bad, passed: false, reasons: ["overfit"] })])).ok, true);
  both(chain([round(), decision(), audit({ ...bad, passed: true })]), {}, "break the audit rule");
  both(chain([round(), decision(), audit({ candidate: { pass: 4, total: 10 }, passed: true })]), {}, "break the audit rule"); // dropped below previous (5)
  both(chain([round(), decision(), audit({ previous: { toolId: "t-dates-v0", pass: 5, total: 12 }, passed: true })]), {}, "break the audit rule"); // different sets
});

test("an audit needs a prior approval, must have proven blocked egress, and cannot repeat for the same set", () => {
  both(chain([round(), audit()]), {}, "never approved");
  both(chain([round(), decision({ decision: "reject" }), audit()]), {}, "never approved");
  both(chain([round(), decision(), audit({ egressBlocked: null })]), {}, "without proven blocked outbound access");
  both(chain([round(), decision(), audit(), audit()]), {}, "audited twice");
  assert.equal(both(chain([round(), decision(), audit(), audit({ auditSetSha: "b".repeat(64) })])).ok, true); // a refreshed set is a new audit
});

test("revoke needs an earlier approval, happens once, and the separation-of-duties rule does not apply to it", () => {
  both(chain([round(), decision({ decision: "revoke" })]), {}, "never approved");
  both(chain([round(), decision({ decision: "reject" }), decision({ decision: "revoke" })]), {}, "never approved");
  both(chain([round(), decision(), decision({ decision: "revoke" }), decision({ decision: "revoke" })]), {}, "revoked more than once");
  // the person who started the round may take their own promoted tool out of service
  assert.equal(both(chain([round({ startedBy: "u-op" }), decision({ reviewerId: "u-rev" }), decision({ decision: "revoke", reviewerId: "u-op" })])).ok, true);
  // ...but still may not approve it
  both(chain([round({ startedBy: "u-op" }), decision({ reviewerId: "u-op" })]), {}, "separation of duties");
});

// ---------- events ----------
test("summariseEvents never invents a good result", () => {
  assert.deepEqual(summariseEvents([]), { sandboxId: null, egressBlocked: null, astOk: null });
  const s = summariseEvents([{ type: "sandbox_created", id: "sb-9" }, { type: "egress_check", blocked: true }, { type: "ast_screen", ok: false }, { type: "ast_screen", ok: true }]);
  assert.deepEqual(s, { sandboxId: "sb-9", egressBlocked: true, astOk: true });
  assert.equal(summariseEvents([{ type: "egress_check", blocked: "yes" }]).egressBlocked, null);
});

// ---------- database store ----------
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

test("db: appends get contiguous sequence numbers and the stored chain verifies", async () => {
  const { signer, pub } = newKey();
  await appendReport(round(), signer);
  await appendReport(decision(), signer);
  const stored = await readChain();
  assert.equal(stored.length, 2);
  assert.equal(stored[0].prev, GENESIS);
  assert.equal(stored[1].prev, stored[0].hash);
  assert.equal(both(stored, { pubkey: pub }).ok, true);
});

test("db: concurrent appends never fork or lose an entry", async () => {
  await Promise.all([1, 2, 3, 4].map((i) => appendReport(round({ roundId: `r-${i}`, toolId: `t-${i}` }), null)));
  const stored = await readChain();
  assert.deepEqual(stored.map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(both(stored).ok, true);
});

test("db: the table refuses UPDATE and DELETE, and an out-of-band edit is still caught by the verifier", async () => {
  await appendReport(round(), null);
  await assert.rejects(async () => { await sql()`update report_chain set body_json = '{}' where seq = 1`; }, /append-only/);
  await assert.rejects(async () => { await sql()`delete from report_chain where seq = 1`; }, /append-only/);
  // Someone with ownership drops the trigger and edits the row: the trigger was never the real defence.
  await pg.exec("drop trigger report_chain_no_change on report_chain");
  await pg.query("update report_chain set body_json = $1 where seq = 1", [canonical({ ...round(), costMicros: 1 })]);
  both(await readChain(), {}, "edited");
});

test("db: a body with undefined fields round-trips to the same hash", async () => {
  const body = { ...round(), cross: undefined } as unknown as RoundBody;
  const e = await appendReport(body, null);
  const [stored] = await readChain();
  assert.equal(stored.hash, e.hash);
  assert.equal(both([stored]).ok, true);
});

// ---------- the command line ----------
test("cli: exit 0 for a good file, 1 for a tampered one, 2 for an unreadable one", () => {
  const dir = mkdtempSync(join(tmpdir(), "evid-"));
  const script = join(process.cwd(), "scripts", "verify-report.mjs");
  const { signer, pub } = newKey();
  const es = chain([round(), decision()], signer);
  const ok = join(dir, "ok.json");
  writeFileSync(ok, JSON.stringify({ publicKey: pub, entries: es }));
  const out = execFileSync("node", [script, ok, "--pubkey", pub, "--head", es[1].hash], { encoding: "utf8" });
  assert.match(out, /VERIFIED/);
  assert.match(out, /checked against the key you pinned/);
  assert.match(out, /Not proven/);

  const bad = join(dir, "bad.json");
  const t = clone(es);
  (t[0].body as RoundBody).heldout!.candidate = 9;
  writeFileSync(bad, JSON.stringify({ entries: t }));
  const r1 = spawnSync("node", [script, bad], { encoding: "utf8" });
  assert.equal(r1.status, 1);
  assert.match(r1.stdout, /FAILED/);

  assert.equal(spawnSync("node", [script, join(dir, "missing.json")], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync("node", [script], { encoding: "utf8" }).status, 2);
  // the key inside the file is NOT trusted unless pinned: the output must say so
  assert.match(execFileSync("node", [script, ok], { encoding: "utf8" }), /NOT checked/);
});
