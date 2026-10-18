// Run: npx tsx --test tests/crosspillar.test.ts
// The cross-pillar interference check: Command -> fixed action table -> Govern, scored on a SEALED end-to-end set.
// Python runs locally (no network, no sandbox quota); the database parts use in-process Postgres (PGlite).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { FAMILIES, PARTNER, type Case } from "../src/lib/bench/cases";
import { __setSqlForTests, ensureSchema, seedHeldoutSet } from "../src/lib/db";
import { decideGate, scoreOutputs, staticScreen, type RunnerOutput } from "../src/lib/gate";
import { runRound } from "../src/lib/round";
import { PIPELINE_PY } from "../src/lib/sandbox/runnerSource";
import { REFERENCE } from "./references";

// Synthetic fixture so the mechanics are tested on any clone; the real sealed set (private/heldout.json) is used when present.
const FIXTURE: Case[] = [
  { input: "Please refund order 9 | amount=10 approved=yes", expected: "allow" },
  { input: "Refund order 9 | amount=10", expected: "block" },
  { input: "Get me a lawyer | approved=no", expected: "block" },
  { input: "Cancel my plan | amount=1", expected: "allow" },
  { input: "Mail the weekly report | recipients=300 approved=yes", expected: "flag" },
];
const privateSet = existsSync("private/heldout.json") ? JSON.parse(readFileSync("private/heldout.json", "utf8")) : null;
const SEALED: Case[] = privateSet?.e2e ?? FIXTURE;

function runPipeline(commandCode: string, governCode: string, cases: Case[]): RunnerOutput {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  writeFileSync(join(dir, "pipeline_runner.py"), PIPELINE_PY);
  writeFileSync(join(dir, "pipe_command.py"), commandCode);
  writeFileSync(join(dir, "pipe_govern.py"), governCode);
  const r = spawnSync("python3", ["-I", join(dir, "pipeline_runner.py"), dir], { input: JSON.stringify({ inputs: cases.map((c) => c.input) }), encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}
const pass = (cmd: string, gov: string, cases = SEALED) => scoreOutputs(cases, runPipeline(cmd, gov, cases)).pass;
const count = (v: boolean[]) => v.filter(Boolean).length;

test("PARTNER pairs Command and Govern, and no other pillar", () => {
  assert.deepEqual(PARTNER, { command: "govern", govern: "command" });
});

test("the reference Command + Govern pair scores 100% on the sealed end-to-end set (labels follow the written rules)", () => {
  assert.equal(count(pass(REFERENCE.command, REFERENCE.govern)), SEALED.length);
});

test("the naive baseline pair leaves room: it does not already solve the end-to-end set", () => {
  const v = pass(FAMILIES.command.baselineCode, FAMILIES.govern.baselineCode);
  assert.ok(count(v) <= SEALED.length * 0.7, `baseline pair scored ${count(v)}/${SEALED.length}`);
});

test("pipeline load errors and bad intents are scored as failures, never as passes", () => {
  const broken = scoreOutputs(SEALED, runPipeline("def normalize(raw:\n", REFERENCE.govern, SEALED));
  assert.equal(broken.count, 0);
  const badIntent = scoreOutputs(SEALED, runPipeline('def normalize(raw):\n    return "banana"\n', REFERENCE.govern, SEALED));
  assert.equal(badIntent.count, 0);
});

// A Command tool that is PERFECT on the Command pillar's own cases but wrong for words that only the sealed set exercises.
const COMMAND_BAD = REFERENCE.command.replace('"manager","supervisor","human"', '"manager","human"').replace('"attorney",', "");

test("INTERFERENCE: a tool can be perfect on its own pillar and still break the pipeline", { skip: !privateSet }, () => {
  const cmd = FAMILIES.command;
  const own = [...cmd.visible, ...cmd.field, ...privateSet.command] as Case[];
  const run = (code: string) => {
    const r = spawnSync("python3", ["-I", "-c", `import sys,json\npayload=json.load(sys.stdin)\nns={}\nexec(payload["code"],ns)\nprint(json.dumps([ns["normalize"](x) for x in payload["inputs"]]))`], { input: JSON.stringify({ code, inputs: own.map((c) => c.input) }), encoding: "utf8" });
    return (JSON.parse(r.stdout.trim()) as unknown[]).filter((o, i) => o === own[i].expected).length;
  };
  assert.equal(run(REFERENCE.command), own.length);
  assert.equal(run(COMMAND_BAD), own.length, "the bad tool must look perfect on the Command pillar's own cases");
  const good = pass(REFERENCE.command, REFERENCE.govern);
  const bad = pass(COMMAND_BAD, REFERENCE.govern);
  assert.ok(count(bad) < count(good), "but it must score lower end to end");
  assert.ok(good.some((p, i) => p && !bad[i]), "and break at least one case that passed before");
});

test("the gate: per-pillar scores improved, but an end-to-end regression blocks promotion; without the cross check it would pass", () => {
  const ok = staticScreen(REFERENCE.command);
  const cur = { visibleCount: 6, heldoutPass: [true, true, true, false, false, false, false, false, false, false] };
  const cand = { visibleCount: 12, heldoutPass: Array(10).fill(true) };
  assert.equal(decideGate(cur, cand, ok).passed, true); // per-pillar view alone: promote
  const crossBroken = { currentPass: [true, true, true, true], candidatePass: [true, false, true, true] };
  const withCross = decideGate(cur, cand, ok, crossBroken);
  assert.equal(withCross.passed, false);
  assert.match(withCross.reasons.join(" "), /cross-pillar/);
  assert.equal(decideGate(cur, cand, ok, { currentPass: [true, false], candidatePass: [true, true] }).passed, true); // improving is fine
  assert.equal(decideGate(cur, cand, ok, { currentPass: [true, true, false], candidatePass: [true, false, true] }).passed, false); // same total, one case broke
});

test("feedback to the model never reveals the cross-pillar details", async () => {
  const { feedbackSafeReasons } = await import("../src/lib/gate");
  const safe = feedbackSafeReasons(["cross-pillar: end-to-end regression on 2 case(s) that passed before", "cross-pillar: end-to-end score dropped (11 < 13)"]).join(" ");
  assert.doesNotMatch(safe, /\d/);
});

let pg: PGlite;
before(async () => {
  pg = new PGlite();
  __setSqlForTests(async (strings, ...values) => {
    const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""), "");
    return (await pg.query(text, values as unknown[])).rows as unknown[];
  });
  await ensureSchema();
});
after(async () => {
  __setSqlForTests(null);
  await pg.close();
});

test("FAIL CLOSED: a command round refuses to start without the sealed end-to-end set, before any sandbox exists", async () => {
  await seedHeldoutSet("command", [{ input: "x", expected: "unknown" }]);
  await assert.rejects(() => runRound({ family: "command", currentCode: FAMILIES.command.baselineCode, partner: { family: "govern", code: FAMILIES.govern.baselineCode } }), /"e2e" is not configured/);
});

test("FAIL CLOSED: a command round refuses to start without the partner tool", async () => {
  await seedHeldoutSet("e2e", FIXTURE);
  await assert.rejects(() => runRound({ family: "command", currentCode: FAMILIES.command.baselineCode }), /partner tool \(govern\) was not provided/);
});
