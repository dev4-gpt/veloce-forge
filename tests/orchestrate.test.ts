// Run: npx tsx --test tests/orchestrate.test.ts
// The Orchestrate pillar is scored by a server-side plan simulator, not exact match. These tests pin the simulator to a
// hand-computed case, cross-check it against an INDEPENDENT Python brute force, and try to cheat it (planted loopholes).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { FAMILIES } from "../src/lib/bench/cases";
import { evaluate, generateJob, makeCase, parseJob, scoreOrchestrate, solve, type Job } from "../src/lib/bench/orchestrateSim";
import { SCORERS } from "../src/lib/bench/scorers";
import { scoreOutputs, staticScreen } from "../src/lib/gate";
import { REFERENCE } from "./references";

// Hand-computed example (see comments). Costs: multi A10 + C5 + B(10+handoff 3) = 28; single 14+14+7 = 35.
const JOB: Job = {
  budget: 100,
  handoff: 3,
  tasks: [
    { id: "A", pillar: "context", cost: 10, value: 8, time: 2, deps: [] },
    { id: "B", pillar: "create", cost: 10, value: 8, time: 2, deps: ["A"] },
    { id: "C", pillar: "govern", cost: 5, value: 4, time: 3, deps: [] },
  ],
};
const plan = (mode: string, steps: string[], extra: object = {}) => ({ mode, steps, ...extra });

test("hand-computed: multi [A,C,B] = value 20, makespan 5 (A 0-2, C 0-3, B 3-5 after a 1-unit handoff), cost 28", () => {
  const v = evaluate(JOB, plan("multi", ["A", "C", "B"]));
  assert.deepEqual(v, { valid: true, net2: 35, cost: 28, makespan: 5 });
});

test("hand-computed: single [A,B,C] = value 20, makespan 7, cost 35 -> doubled score 33", () => {
  const v = evaluate(JOB, plan("single", ["A", "B", "C"]));
  assert.deepEqual(v, { valid: true, net2: 33, cost: 35, makespan: 7 });
});

test("the brute-force solver finds optimum 35 and best single-agent 33 for that job", () => {
  assert.deepEqual(solve(JOB), { optimum2: 35, single2: 33 });
});

test("the pass rule needs validity, at least the best single plan, and within 10% of the optimum", () => {
  const c = { input: JSON.stringify(JOB), expected: JSON.stringify(solve(JOB)) };
  assert.equal(scoreOrchestrate(c, JSON.stringify(plan("multi", ["A", "C", "B"]))), true); // optimal
  assert.equal(scoreOrchestrate(c, JSON.stringify(plan("single", ["A", "B", "C"]))), true); // best single plan (33) is within 10% of 35, so the rule accepts it
  assert.equal(scoreOrchestrate(c, JSON.stringify(plan("multi", ["A", "B"]))), false); // valid, within budget, but incomplete (net 27 < 33)
});

test("when parallel work clearly pays, the best SINGLE plan no longer passes (the benchmark rewards orchestrating)", () => {
  const par: Job = {
    budget: 100,
    handoff: 3,
    tasks: [
      { id: "A", pillar: "context", cost: 5, value: 10, time: 4, deps: [] },
      { id: "B", pillar: "create", cost: 5, value: 10, time: 4, deps: [] },
      { id: "C", pillar: "govern", cost: 5, value: 10, time: 4, deps: [] },
    ],
  };
  assert.deepEqual(solve(par), { optimum2: 56, single2: 48 }); // multi: 60 - 4, single: 60 - 12
  const c = { input: JSON.stringify(par), expected: JSON.stringify(solve(par)) };
  assert.equal(scoreOrchestrate(c, JSON.stringify(plan("single", ["A", "B", "C"]))), false); // 48 < 0.9 * 56
  assert.equal(scoreOrchestrate(c, JSON.stringify(plan("multi", ["A", "B", "C"]))), true);
});

test("when coordination costs more than it saves, a single agent IS the right answer (handoffs are not free)", () => {
  const chain: Job = {
    budget: 100,
    handoff: 20,
    tasks: [
      { id: "A", pillar: "context", cost: 5, value: 10, time: 2, deps: [] },
      { id: "B", pillar: "create", cost: 5, value: 10, time: 2, deps: ["A"] },
      { id: "C", pillar: "govern", cost: 5, value: 10, time: 2, deps: ["B"] },
    ],
  };
  const s = solve(chain);
  assert.equal(s.optimum2, s.single2, "no multi plan beats single when every step waits on a handoff");
  const c = { input: JSON.stringify(chain), expected: JSON.stringify(s) };
  assert.equal(scoreOrchestrate(c, JSON.stringify(plan("single", ["A", "B", "C"]))), true);
});

// ---- planted loopholes: every one must be INVALID and therefore fail ----
const BAD: [string, unknown][] = [
  ["duplicate step double-counts value (right length, only the duplicate is wrong)", plan("multi", ["A", "A", "C"])],
  ["missing dependency", plan("multi", ["B"])],
  ["runs before its dependency", plan("multi", ["B", "A", "C"])],
  ["unknown task id", plan("multi", ["A", "B", "C", "Z"])],
  ["extra key (a hidden bonus field)", plan("multi", ["A", "C", "B"], { bonus: 999 })],
  ["start times supplied by the model", plan("multi", ["A", "C", "B"], { start: { A: 0 } })],
  ["unknown mode", plan("turbo", ["A", "C", "B"])],
  ["steps is not a list of strings", { mode: "multi", steps: [1, 2, 3] }],
  ["too many steps", plan("multi", ["A", "B", "C", "A"])],
  ["a list instead of an object", ["A", "B", "C"]],
];
for (const [name, p] of BAD) {
  test(`loophole rejected: ${name}`, () => {
    assert.equal(evaluate(JOB, p).valid, false);
    const c = { input: JSON.stringify(JOB), expected: JSON.stringify(solve(JOB)) };
    assert.equal(scoreOrchestrate(c, JSON.stringify(p)), false);
  });
}

test("loophole rejected: going over budget", () => {
  const tight = { ...JOB, budget: 20 };
  assert.equal(evaluate(tight, plan("multi", ["A", "C", "B"])).valid, false);
});

test("loophole rejected: a free high-value task that depends on an unaffordable one cannot be claimed by skipping its dependency", () => {
  const trap: Job = {
    budget: 40,
    handoff: 2,
    tasks: [
      { id: "X", pillar: "create", cost: 50, value: 1, time: 1, deps: [] },
      { id: "Y", pillar: "deliver", cost: 0, value: 1000, time: 1, deps: ["X"] },
    ],
  };
  assert.deepEqual(solve(trap), { optimum2: 0, single2: 0 }); // nothing affordable: the honest optimum is the empty plan
  const c = { input: JSON.stringify(trap), expected: JSON.stringify(solve(trap)) };
  assert.equal(scoreOrchestrate(c, JSON.stringify(plan("multi", ["Y"]))), false); // the 2000-point cheat
  assert.equal(scoreOrchestrate(c, JSON.stringify(plan("multi", ["X", "Y"]))), false); // over budget
  assert.equal(scoreOrchestrate(c, JSON.stringify(plan("single", []))), true); // the empty plan is legitimate here
});

test("non-JSON, non-string and hostile outputs fail without throwing", () => {
  const c = { input: JSON.stringify(JOB), expected: JSON.stringify(solve(JOB)) };
  for (const bad of ["I think multi is best", "", "{", null, undefined, 42, { mode: "multi" }]) assert.equal(scoreOrchestrate(c, bad), false);
  assert.equal(scoreOrchestrate({ input: "not json", expected: c.expected }, "{}"), false);
});

test("the job parser rejects malformed input (negative values, cycles to unknown ids, too many tasks)", () => {
  assert.equal(parseJob(JSON.stringify({ ...JOB, tasks: [{ ...JOB.tasks[0], value: -1 }] })), null);
  assert.equal(parseJob(JSON.stringify({ ...JOB, tasks: [{ ...JOB.tasks[0], deps: ["nope"] }] })), null);
  assert.equal(parseJob(JSON.stringify({ ...JOB, tasks: Array.from({ length: 9 }, (_, i) => ({ id: `T${i}`, pillar: "x", cost: 1, value: 1, time: 1, deps: [] })) })), null);
  assert.ok(parseJob(JSON.stringify(JOB)));
});

test("the generator is deterministic per seed, builds valid DAGs, and its cases carry a solver-computed optimum", () => {
  for (const seed of [1, 7, 42, 999]) {
    assert.deepEqual(generateJob(seed), generateJob(seed));
    const job = generateJob(seed);
    assert.ok(job.tasks.length >= 4 && job.tasks.length <= 6);
    job.tasks.forEach((t, i) => t.deps.forEach((d) => assert.ok(job.tasks.findIndex((x) => x.id === d) < i, "deps point only to earlier tasks")));
    const c = makeCase(seed);
    assert.deepEqual(JSON.parse(c.expected), solve(parseJob(c.input)!));
  }
  assert.notDeepEqual(generateJob(1), generateJob(2));
});

// ---- independent cross-check against a Python brute force ----
const harness = `import sys, json
p = json.load(sys.stdin); ns = {}; exec(p["code"], ns)
print(json.dumps([ns["normalize"](x) for x in p["inputs"]]))`;
const runPy = (code: string, inputs: string[]): string[] => {
  const r = spawnSync("python3", ["-I", "-c", harness], { input: JSON.stringify({ code, inputs }), encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim());
};
const spec = FAMILIES.orchestrate;
const publicCases = [...spec.visible, ...spec.field];
const privateSet = existsSync("private/heldout.json") ? JSON.parse(readFileSync("private/heldout.json", "utf8")).orchestrate : null;

test("an independent Python planner reaches EXACTLY the TypeScript solver's optimum on every public case (two implementations agree)", () => {
  const out = runPy(REFERENCE.orchestrate, publicCases.map((c) => c.input));
  publicCases.forEach((c, i) => {
    const v = evaluate(parseJob(c.input)!, JSON.parse(out[i]));
    assert.ok(v.valid && v.net2 === JSON.parse(String(c.expected)).optimum2, `case ${i}`);
  });
});

test("the same holds for the private sealed set (when present locally)", { skip: !privateSet }, () => {
  const out = runPy(REFERENCE.orchestrate, privateSet.map((c: { input: string }) => c.input));
  privateSet.forEach((c: { input: string; expected: string }, i: number) => {
    const v = evaluate(parseJob(c.input)!, JSON.parse(out[i]));
    assert.ok(v.valid && v.net2 === JSON.parse(c.expected).optimum2, `sealed case ${i}`);
  });
});

test("the naive baseline leaves real room: it passes under 60% of public and sealed cases", () => {
  const cases = [...publicCases, ...(privateSet ?? [])];
  const out = runPy(spec.baselineCode, cases.map((c) => c.input));
  const passed = cases.filter((c, i) => scoreOrchestrate(c, out[i])).length;
  assert.ok(passed < cases.length * 0.6, `baseline passed ${passed}/${cases.length}`);
});

test("multi-agent plans genuinely beat single-agent plans on most sealed cases (so the benchmark rewards orchestrating when it pays)", { skip: !privateSet }, () => {
  const better = privateSet.filter((c: { expected: string }) => JSON.parse(c.expected).optimum2 > JSON.parse(c.expected).single2).length;
  assert.ok(better >= privateSet.length * 0.5 && better < privateSet.length, `${better}/${privateSet.length}`);
});

test("the scorer hook plugs into scoreOutputs; families without a scorer still use exact match", () => {
  const c = publicCases[0];
  const good = JSON.stringify(JSON.parse(runPy(REFERENCE.orchestrate, [c.input])[0]));
  assert.equal(scoreOutputs([c], { outputs: [{ ok: good }] }, SCORERS.orchestrate).count, 1);
  assert.equal(scoreOutputs([c], { outputs: [{ ok: good }] }).count, 0); // exact match against the expected JSON string would fail
  assert.equal(SCORERS.dates, undefined);
});

test("the reference planner passes the static screen only when json is allowed for this pillar", () => {
  assert.equal(staticScreen(REFERENCE.orchestrate, spec.extraImports).ok, true);
  assert.equal(staticScreen(REFERENCE.orchestrate).ok, false);
});

test("the Orchestrate agent has its own role and rules", () => {
  assert.equal(spec.pillar, "orchestrate");
  assert.ok(spec.agentRole.includes("single generalist agent"));
  assert.ok(spec.instruction.includes("EXACTLY the keys mode and steps"));
});
