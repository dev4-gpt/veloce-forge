// Run: npx tsx --test tests/audit.test.ts
// The fresh-audit check: decision rule, storage, revoke, and the whole run (real runner script executed locally through a fake
// sandbox, real SQL on PGlite). Private audit sets are validated against independent references when present locally.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { FAMILIES, sha256, type Case } from "../src/lib/bench/cases";
import { __setSqlForTests, credit, ensureSchema, getActive, getTool, getWallet, insertTool, review, seedHeldoutSet, sql } from "../src/lib/db";
import { auditKey, decideAudit, getAudit, latestAuditFor, previousTool, revokeTool, saveAudit } from "../src/lib/audit";
import { AUDIT_CAP_MICROS, runAuditForTool, type AuditSandbox } from "../src/lib/auditRun";
import { auditCountsOk, type AuditBody } from "../src/lib/evidence";
import { allowedImports, type RunnerOutput } from "../src/lib/gate";
import { walletPayer } from "../src/lib/payer";
import { RUNNER_PY } from "../src/lib/sandbox/runnerSource";
import { REFERENCE } from "./references";

const pass = (n: number, total: number) => Array.from({ length: total }, (_, i) => i < n);

// ---------- the decision rule ----------
test("audit passes when the new tool is at least as good as the old one and the held-out score is not far above the audit score", () => {
  assert.deepEqual(decideAudit({ prevPass: pass(5, 10), candPass: pass(8, 10), heldout: { pass: 9, total: 10 } }), { passed: true, reasons: [] });
  assert.equal(decideAudit({ prevPass: pass(8, 10), candPass: pass(8, 10), heldout: { pass: 10, total: 10 } }).passed, true);
});

test("audit fails when the audit score drops below the version it replaced", () => {
  const d = decideAudit({ prevPass: pass(8, 10), candPass: pass(6, 10), heldout: { pass: 7, total: 10 } });
  assert.equal(d.passed, false);
  assert.match(d.reasons.join(), /dropped/);
});

test("audit fails on a regression even when the totals are equal", () => {
  const prev = [true, true, true, true, true, false, false, false, false, false];
  const cand = [false, true, true, true, true, true, false, false, false, false]; // lost case 0, gained case 5
  const d = decideAudit({ prevPass: prev, candPass: cand, heldout: { pass: 6, total: 10 } });
  assert.equal(d.passed, false);
  assert.match(d.reasons.join(), /regression on 1/);
});

test("audit fails when the held-out rate is far above the unseen audit rate (selected for the held-out set)", () => {
  const d = decideAudit({ prevPass: pass(4, 10), candPass: pass(6, 10), heldout: { pass: 10, total: 10 } });
  assert.equal(d.passed, false);
  assert.match(d.reasons.join(), /overfit/);
  assert.equal(decideAudit({ prevPass: pass(4, 10), candPass: pass(7, 10), heldout: { pass: 10, total: 10 } }).passed, true); // a gap of exactly 3/10 is allowed
});

test("audit fails closed on empty or mismatched results", () => {
  assert.equal(decideAudit({ prevPass: [], candPass: [], heldout: { pass: 1, total: 1 } }).passed, false);
  assert.equal(decideAudit({ prevPass: pass(1, 3), candPass: pass(3, 5), heldout: { pass: 1, total: 1 } }).passed, false);
});

test("auditCountsOk uses integer arithmetic and rejects impossible totals", () => {
  assert.equal(auditCountsOk({ pass: 10, total: 10 }, { pass: 7, total: 10 }, { pass: 7, total: 10 }), true);
  assert.equal(auditCountsOk({ pass: 10, total: 10 }, { pass: 6, total: 10 }, { pass: 6, total: 10 }), false);
  assert.equal(auditCountsOk({ pass: 0, total: 0 }, { pass: 1, total: 1 }, { pass: 1, total: 1 }), false);
  assert.equal(auditCountsOk({ pass: 5, total: 10 }, { pass: 5, total: 10 }, { pass: 5, total: 12 }), false); // different sets
});

// ---------- independent references validate every label (and the private audit sets when present) ----------
function runPython(code: string, inputs: string[]): { ok?: unknown }[] {
  const harness = `import sys, json
p = json.load(sys.stdin)
ns = {}
exec(p["code"], ns)
out = []
for x in p["inputs"]:
    try:
        out.append({"ok": ns["normalize"](x)})
    except BaseException as e:
        out.append({"err": type(e).__name__})
print(json.dumps(out))`;
  const r = spawnSync("python3", ["-I", "-c", harness], { input: JSON.stringify({ code, inputs }), encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}
const refScore = (f: string, cases: Case[]) => runPython(REFERENCE[f], cases.map((c) => c.input)).filter((o, i) => "ok" in o && o.ok === cases[i].expected).length;
const heldoutFile = existsSync("private/heldout.json") ? JSON.parse(readFileSync("private/heldout.json", "utf8")) : null;
const auditFile = existsSync("private/audit.json") ? JSON.parse(readFileSync("private/audit.json", "utf8")) : null;

for (const f of ["dates", "money", "durations"] as const) {
  test(`${f}: the independent reference reproduces every public label`, () => {
    const cases = [...FAMILIES[f].visible, ...FAMILIES[f].field];
    assert.equal(refScore(f, cases), cases.length);
  });
}

test("private held-out and audit sets: labels match the references, audit sets are disjoint from everything the proposer or gate sees", { skip: !auditFile || !heldoutFile }, () => {
  for (const f of ["dates", "money", "durations", "command", "context", "govern"] as const) {
    assert.equal(refScore(f, heldoutFile[f]), heldoutFile[f].length, `${f} held-out`);
    assert.equal(refScore(f, auditFile[f]), auditFile[f].length, `${f} audit`);
  }
  for (const f of Object.keys(FAMILIES) as (keyof typeof FAMILIES)[]) {
    const seen = new Set<string>([...FAMILIES[f].visible, ...FAMILIES[f].field, ...(heldoutFile[f] ?? [])].map((c: Case) => c.input));
    for (const c of auditFile[f] ?? []) assert.equal(seen.has(c.input), false, `${f}: audit case "${String(c.input).slice(0, 40)}" also appears elsewhere`);
    assert.ok((auditFile[f] ?? []).length >= 5, `${f}: audit set too small`);
  }
});

// ---------- database + run ----------
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

const SPEC = FAMILIES.dates;
const HELD: Case[] = [...SPEC.visible]; // synthetic "held-out" for the test: 6 cases
const AUDIT: Case[] = [...SPEC.field]; // synthetic "audit" set: 6 different cases
const GOOD = REFERENCE.dates;
const cheat = (cases: Case[]) =>
  `TABLE = ${JSON.stringify(Object.fromEntries(cases.map((c) => [c.input, c.expected])))}\n\ndef normalize(raw):\n    if raw in TABLE:\n        return TABLE[raw]\n    raise ValueError("unknown")\n`;

async function seedSets(audit = true) {
  await seedHeldoutSet("dates", HELD);
  if (audit) await seedHeldoutSet(auditKey("dates"), AUDIT);
}

/** v0 baseline (active) -> v1 proposed -> approved: v1 active, v0 superseded. Returns the promoted tool. */
async function promote(code: string, heldoutCount: number, version = 1) {
  await getActive("dates");
  await seedHeldoutSet("dates", HELD); // approval requires the proposal's held-out commitment to match the stored set (a no-op if already seeded)
  const id = `t-dates-v${version}`;
  await insertTool({
    id, family: "dates", version, code, sha: sha256(code), status: "proposed", visible_count: 6, heldout_count: heldoutCount,
    heldout_pass: Array.from({ length: HELD.length }, (_, i) => i < heldoutCount), heldout_sha: sha256(JSON.stringify(HELD)), round_id: null, rationale: "x", gate: { passed: true, reasons: [] },
  });
  assert.deepEqual(await review(id, "approve", sha256(code), null), { ok: true });
  return (await getTool(id))!;
}

/** A sandbox that runs the REAL runner script locally (python3 -I) instead of a CreateOS microVM. */
function localSandbox(over: Partial<{ egressBlocked: boolean; failRun: boolean; execMs: number | null }> = {}) {
  const log = { opened: 0, closed: 0, runs: 0 };
  const sb: AuditSandbox = {
    async open() {
      log.opened++;
      return { id: "sb-local" };
    },
    async probeEgressBlocked() {
      return { blocked: over.egressBlocked ?? true, execMs: 1 };
    },
    async run(_id, code, inputs, allowed) {
      log.runs++;
      if (over.failRun) throw new Error("sandbox exec failed");
      const dir = mkdtempSync(join(tmpdir(), "aud-"));
      writeFileSync(join(dir, "runner.py"), RUNNER_PY);
      writeFileSync(join(dir, "candidate.py"), code);
      const r = spawnSync("python3", ["-I", join(dir, "runner.py"), dir], { input: JSON.stringify({ inputs, allowed }), encoding: "utf8", timeout: 30_000 });
      assert.equal(r.status, 0, r.stderr);
      return { out: JSON.parse(r.stdout.trim().split("\n").pop()!) as RunnerOutput, execMs: over.execMs === undefined ? 7 : over.execMs };
    },
    async close() {
      log.closed++;
    },
  };
  return { sb, log };
}
const run = (id: string, sb: AuditSandbox, bodies: AuditBody[] = []) =>
  runAuditForTool(id, { sandbox: sb, record: async (b) => void bodies.push(b) });

test("a good promotion passes its fresh audit, is charged, recorded and the sandbox is destroyed", async () => {
  await credit("k", 1_000_000, "t");
  await seedSets();
  const tool = await promote(GOOD, 6);
  const { sb, log } = localSandbox();
  const bodies: AuditBody[] = [];
  const out = await run(tool.id, sb, bodies);
  assert.equal(out.status, "passed");
  assert.deepEqual((out as { audit: { reasons: string[] } }).audit.reasons, []);
  assert.deepEqual(log, { opened: 1, closed: 1, runs: 2 }); // candidate and the version it replaced, in one sandbox
  const w = await getWallet();
  assert.equal(w.held, 0);
  assert.ok(w.balance < 1_000_000 && w.balance > 1_000_000 - AUDIT_CAP_MICROS);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].kind, "audit");
  assert.equal(bodies[0].passed, true);
  assert.equal(bodies[0].egressBlocked, true);
  assert.equal(bodies[0].candidate.total, AUDIT.length);
  assert.equal(bodies[0].auditSetSha.length, 64);
  assert.equal((await getTool(tool.id))!.status, "active"); // an audit never changes a tool's status itself
});

test("a tool that memorised the held-out set fails the audit, and stays active until a person decides", async () => {
  await credit("k", 1_000_000, "t");
  await seedSets();
  const tool = await promote(cheat(HELD), 6);
  const out = await run(tool.id, localSandbox().sb);
  assert.equal(out.status, "failed");
  assert.match((out as { audit: { reasons: string[] } }).audit.reasons.join(), /overfit|dropped|regression/);
  assert.equal((await getTool(tool.id))!.status, "active");
  assert.equal((await latestAuditFor(tool.id))!.status, "failed");
});

test("a tool worse than the version it replaced fails the audit", async () => {
  await credit("k", 1_000_000, "t");
  await seedSets();
  const first = await promote(GOOD, 6, 1);
  const worse = `def normalize(raw):\n    raise ValueError("no")\n`;
  const second = await promote(worse, 6, 2);
  assert.equal((await previousTool(second))!.id, first.id);
  assert.equal((await run(second.id, localSandbox().sb)).status, "failed");
});

test("the same tool and set is audited once: a repeat is reused without a second sandbox or charge", async () => {
  await credit("k", 1_000_000, "t");
  await seedSets();
  const tool = await promote(GOOD, 6);
  await run(tool.id, localSandbox().sb);
  const balance = (await getWallet()).balance;
  const again = localSandbox();
  const out = await run(tool.id, again.sb);
  assert.equal(out.status, "passed");
  assert.equal((out as { reused?: boolean }).reused, true);
  assert.equal(again.log.opened, 0);
  assert.equal((await getWallet()).balance, balance);
});

test("skips never open a sandbox: no audit set, unfunded wallet, unknown or inactive tool, no held-out standing", async () => {
  await seedSets(false); // held-out only: no audit set, and no credits yet
  const tool0 = await promote(GOOD, 6);
  const l = localSandbox();
  const noSet = await run(tool0.id, l.sb);
  assert.match(noSet.status === "skipped" ? noSet.reason : "", /no audit set/);
  await seedSets(true);
  const unfunded = await run(tool0.id, l.sb);
  assert.equal(unfunded.status, "skipped");
  assert.match(unfunded.status === "skipped" ? unfunded.reason : "", /not paid for/);
  assert.equal((await run("t-nope", l.sb)).status, "skipped");
  await credit("k", 1_000_000, "t");
  await sql()`update tools set status = 'rejected' where id = ${tool0.id}`;
  assert.equal((await run(tool0.id, l.sb)).status, "skipped"); // not active
  await sql()`update tools set status = 'active', heldout_count = null where id = ${tool0.id}`;
  assert.equal((await run(tool0.id, l.sb)).status, "skipped"); // held-out standing unknown
  assert.equal(l.log.opened, 0);
  assert.deepEqual(await getWallet(), { balance: 1_000_000, held: 0 });
});

test("if outbound access is not blocked, no model-written code runs, the money stays held, and the sandbox is destroyed", async () => {
  await credit("k", 1_000_000, "t");
  await seedSets();
  const tool = await promote(GOOD, 6);
  const { sb, log } = localSandbox({ egressBlocked: false });
  assert.equal((await run(tool.id, sb)).status, "skipped");
  assert.equal(log.runs, 0);
  assert.equal(log.closed, 1);
  assert.equal((await getWallet()).held, AUDIT_CAP_MICROS); // work began, usage unknown: not released, not zero
  assert.equal(await latestAuditFor(tool.id), null);
});

test("a sandbox that fails mid-audit is a skipped audit, not a failed one, and the hold stays", async () => {
  await credit("k", 1_000_000, "t");
  await seedSets();
  const tool = await promote(GOOD, 6);
  const { sb, log } = localSandbox({ failRun: true });
  assert.equal((await run(tool.id, sb)).status, "skipped");
  assert.equal(log.closed, 1);
  assert.equal((await getWallet()).held, AUDIT_CAP_MICROS);
  assert.equal(await latestAuditFor(tool.id), null);
});

test("unknown sandbox usage is never priced as zero: the money stays held and the cost is recorded as unknown", async () => {
  await credit("k", 1_000_000, "t");
  await seedSets();
  const tool = await promote(GOOD, 6);
  const bodies: AuditBody[] = [];
  const out = await run(tool.id, localSandbox({ execMs: null }).sb, bodies);
  assert.equal(out.status, "passed"); // the audit result itself is fine
  assert.equal(bodies[0].costMicros, null);
  assert.equal((await getWallet()).held, AUDIT_CAP_MICROS);
});

test("audits are immutable and saving twice keeps the first result", async () => {
  await seedSets();
  const tool = await promote(GOOD, 6);
  const base = { tool_id: tool.id, set_sha: "s".repeat(64), family: "dates", status: "passed" as const, cand_pass: pass(6, 6), prev_tool_id: "t-dates-v0", prev_pass: pass(2, 6), heldout_pass: 6, heldout_total: 6, reasons: [], sandbox_id: null, cost_micros: 1 };
  await saveAudit(base);
  assert.equal((await saveAudit({ ...base, status: "failed", reasons: ["x"] })).status, "passed");
  assert.equal((await getAudit(tool.id, base.set_sha))!.status, "passed");
  await assert.rejects(async () => { await sql()`update audits set status = 'failed'`; }, /append-only/);
  await assert.rejects(async () => { await sql()`delete from audits`; }, /append-only/);
});

// ---------- revoke ----------
test("revoke puts the previous version back in service in one step, with a recorded approval row", async () => {
  const first = await promote(GOOD, 6, 1);
  const second = await promote(cheat(HELD), 6, 2);
  assert.equal((await getActive("dates")).id, second.id);
  assert.deepEqual(await revokeTool(second.id, second.sha, "u-rev"), { ok: true, restored: first.id });
  assert.equal((await getTool(second.id))!.status, "revoked");
  assert.equal((await getActive("dates")).id, first.id);
  const act = (await sql()`select count(*) as n from tools where family = 'dates' and status = 'active'`) as { n: number }[];
  assert.equal(Number(act[0].n), 1);
  const rows = (await sql()`select decision, reviewer_id, sha_at_decision from approvals where tool_id = ${second.id} order by id desc limit 1`) as any[];
  assert.deepEqual([rows[0].decision, rows[0].reviewer_id, rows[0].sha_at_decision], ["revoke", "u-rev", second.sha]);
});

test("revoke refuses the wrong hash, a tool that is not active, a second revoke, and a family with nothing to restore", async () => {
  const tool = await promote(GOOD, 6, 1);
  assert.match((await revokeTool(tool.id, "0".repeat(64), null)).error ?? "", /hash mismatch/);
  assert.equal((await getTool(tool.id))!.status, "active"); // nothing changed
  assert.match((await revokeTool("t-nope", tool.sha, null)).error ?? "", /not found/);
  const v0 = (await getTool("t-dates-v0"))!;
  assert.match((await revokeTool(v0.id, v0.sha, null)).error ?? "", /not active/);
  assert.equal((await revokeTool(tool.id, tool.sha, null)).ok, true);
  assert.match((await revokeTool(tool.id, tool.sha, null)).error ?? "", /not active/);
  // v0 is now the only version and has no earlier version: refuse rather than leave the family without an active tool
  assert.match((await revokeTool(v0.id, v0.sha, null)).error ?? "", /no earlier version/);
  assert.equal((await getActive("dates")).id, "t-dates-v0");
});

test("a revoked version is skipped when looking for what a later tool replaced", async () => {
  const v1 = await promote(GOOD, 6, 1);
  const v2 = await promote(cheat(HELD), 6, 2);
  await revokeTool(v2.id, v2.sha, null);
  const v3 = await promote(GOOD + "\n# v3\n", 6, 3);
  assert.equal((await previousTool(v3))!.id, v1.id);
});

test("the audit runner imports follow the family spec, and the audit is paid through the wallet payer", () => {
  assert.ok(allowedImports(FAMILIES.orchestrate.extraImports).includes("json"));
  assert.equal(walletPayer("r", 1).mode, "wallet");
});
