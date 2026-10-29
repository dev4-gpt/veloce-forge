// Run: npx tsx --test tests/tamper.test.ts
// Evaluator-tamper checks: model-written code must not be able to change how it is scored. Each case is an attack on the
// scoring path (forge the result, hang the runner, emit unparseable output, fake equality, read the answers). The product's
// own parse-and-score steps are replayed locally, so a case passes only when the attack ends as a FAIL for the candidate.
// Python runs locally on throwaway files; nothing here needs the network, the database or sandbox quota.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { equalValue, type Case } from "../src/lib/bench/cases";
import { allowedImports, scoreOutputs, type RunnerOutput } from "../src/lib/gate";
import { AST_SCREEN_PY, RUNNER_PY } from "../src/lib/sandbox/runnerSource";

const wrap = (body: string) => `def normalize(raw):\n    ${body}\n`;

/** Runs the real runner script the way the sandbox does (stdin payload, outer kill timer) and returns the raw process result. */
function runRaw(code: string, inputs: string[], killAfterMs = 30_000) {
  const dir = mkdtempSync(join(tmpdir(), "tamper-"));
  writeFileSync(join(dir, "runner.py"), RUNNER_PY);
  writeFileSync(join(dir, "candidate.py"), code);
  return spawnSync("python3", ["-I", join(dir, "runner.py"), dir], { input: JSON.stringify({ inputs, allowed: allowedImports() }), encoding: "utf8", timeout: killAfterMs });
}

/** Mirrors runInSandbox in src/lib/round.ts: last stdout line is parsed, anything else becomes a load_error. */
function parseLikeProduct(stdout: string | null, note: string): RunnerOutput {
  const last = (stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
  try {
    return JSON.parse(last) as RunnerOutput;
  } catch {
    return { load_error: `runner failed: ${note}` };
  }
}

const cases = (n: number, expected: string | number): Case[] => Array.from({ length: n }, (_, i) => ({ input: `in${i}`, expected }));
const inputsOf = (cs: Case[]) => cs.map((c) => c.input);
const allFail = (s: { pass: boolean[] }) => s.pass.every((p) => !p);

function screen(code: string): { ok: boolean; reasons: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "tamper-ast-"));
  writeFileSync(join(dir, "ast_screen.py"), AST_SCREEN_PY);
  writeFileSync(join(dir, "candidate.py"), code);
  const r = spawnSync("python3", ["-I", join(dir, "ast_screen.py"), join(dir, "candidate.py"), JSON.stringify(allowedImports())], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

test("a candidate that swallows the timeout and loops forever is killed from outside and scores zero", () => {
  const code = wrap("while True:\n        try:\n            while True:\n                pass\n        except Exception:\n            pass");
  const cs = cases(3, "allow");
  const r = runRaw(code, inputsOf(cs), 6_000); // stands in for the sandbox's `timeout 20`
  assert.equal(r.status, null, "the runner must not finish on its own");
  assert.equal(r.signal, "SIGTERM");
  assert.ok(allFail(scoreOutputs(cs, parseLikeProduct(r.stdout, "killed"))));
});

test("a candidate that returns NaN or Infinity produces unparseable output, which fails closed", () => {
  for (const v of ["float('nan')", "float('inf')", "[float('nan')]"]) {
    const cs = cases(2, 5);
    const r = runRaw(wrap(`return ${v}`), inputsOf(cs));
    assert.equal(r.status, 0);
    assert.throws(() => JSON.parse(r.stdout.trim()), `${v} must not be valid JSON`);
    assert.ok(allFail(scoreOutputs(cs, parseLikeProduct(r.stdout, "bad json"))));
  }
});

test("a str subclass with a forged __eq__ reaches the scorer as a plain string and is compared by value", () => {
  const code = "class S(str):\n    def __eq__(self, o):\n        return True\n    def __hash__(self):\n        return 0\n" + wrap("return S('wrong')");
  const cs = cases(2, "allow");
  const r = runRaw(code, inputsOf(cs));
  const out = parseLikeProduct(r.stdout, "x");
  assert.deepEqual(out, { outputs: [{ ok: "wrong" }, { ok: "wrong" }] });
  assert.ok(allFail(scoreOutputs(cs, out)));
});

test("printing a forged result, even a full valid one, cannot replace the runner's own line", () => {
  const forged = JSON.stringify({ outputs: [{ ok: "allow" }, { ok: "allow" }] });
  const cs = cases(2, "allow");
  const r = runRaw(wrap(`print(${JSON.stringify(forged)})\n    return 'block'`), inputsOf(cs));
  assert.equal(r.stdout.trim().split("\n").length, 1);
  assert.ok(allFail(scoreOutputs(cs, parseLikeProduct(r.stdout, "x"))));
});

test("the wrong number of outputs (dropped or padded) scores zero, never partial credit", () => {
  const cs = cases(3, "a");
  assert.ok(allFail(scoreOutputs(cs, { outputs: [{ ok: "a" }, { ok: "a" }] })));
  assert.ok(allFail(scoreOutputs(cs, { outputs: [{ ok: "a" }, { ok: "a" }, { ok: "a" }, { ok: "a" }] })));
  assert.ok(allFail(scoreOutputs(cs, {} as RunnerOutput)));
});

test("scoring is type strict: true is not 1, a numeric string is not a number, and the reverse", () => {
  assert.equal(equalValue(true, 1), false);
  assert.equal(equalValue("1", 1), false);
  assert.equal(equalValue(1, "1"), false);
  assert.equal(equalValue(null, "none"), false);
  assert.equal(equalValue(["allow"], "allow"), false);
  const r = runRaw(wrap("return True"), ["x"]);
  assert.equal(scoreOutputs(cases(1, 1), parseLikeProduct(r.stdout, "x")).count, 0);
});

test("the runner and the screen never contain expected values, and the runner only echoes what the candidate returns", () => {
  assert.doesNotMatch(RUNNER_PY, /expected/i);
  assert.doesNotMatch(AST_SCREEN_PY, /expected/i);
  const r = runRaw("import re\n" + wrap("return raw"), ["only-the-input"]);
  assert.equal(r.stdout.includes("expected"), false);
});

test("the screen rejects attempts to reach the runner's globals, stdin, or scoring objects", () => {
  const attacks: [string, string][] = [
    ["read stdin through sys", "import sys\n" + wrap("return sys.stdin.read()")],
    ["reach the real stdout", wrap("return print.__self__")],
    ["walk to the runner frame", wrap("return normalize.__globals__['payload']")],
    ["rebind the restricted import", wrap("return __builtins__")],
    ["reach modules through an allowed module", "import re\n" + wrap("return re.sys.modules['__main__']")],
    ["load the runner module", "import importlib\n" + wrap("return importlib.import_module('runner')")],
  ];
  for (const [name, code] of attacks) assert.equal(screen(code).ok, false, name);
});
