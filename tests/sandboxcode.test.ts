// Run: npx tsx --test tests/sandboxcode.test.ts
// Defence in depth for MODEL-WRITTEN code: the syntax-tree screen and the restricted runner. Python runs locally on throwaway
// files; nothing here is a substitute for the real boundary (the CreateOS microVM with outbound access blocked).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FAMILIES, FAMILY_LIST } from "../src/lib/bench/cases";
import { allowedImports } from "../src/lib/gate";
import { AST_SCREEN_PY, RUNNER_PY } from "../src/lib/sandbox/runnerSource";
import { REFERENCE } from "./references";

function screen(code: string, extra: string[] = []): { ok: boolean; reasons: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "ast-"));
  writeFileSync(join(dir, "ast_screen.py"), AST_SCREEN_PY);
  writeFileSync(join(dir, "candidate.py"), code);
  const r = spawnSync("python3", ["-I", join(dir, "ast_screen.py"), join(dir, "candidate.py"), JSON.stringify(allowedImports(extra))], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

function runner(code: string, inputs: string[], extra: string[] = []): any {
  const dir = mkdtempSync(join(tmpdir(), "run-"));
  writeFileSync(join(dir, "runner.py"), RUNNER_PY);
  writeFileSync(join(dir, "candidate.py"), code);
  const r = spawnSync("python3", ["-I", join(dir, "runner.py"), dir], { input: JSON.stringify({ inputs, allowed: allowedImports(extra) }), encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

const wrap = (body: string) => `def normalize(raw):\n    ${body}\n`;

// ---- the escape corpus: each must be REJECTED by the syntax-tree screen alone ----
const ESCAPES: [string, string, RegExp][] = [
  ["import os", "import os\n" + wrap("return raw"), /import not allowed: os/],
  ["from subprocess import", "from subprocess import run\n" + wrap("return raw"), /import not allowed: subprocess/],
  ["relative import", "from . import x\n" + wrap("return raw"), /import not allowed/],
  ["star import", "from re import *\n" + wrap("return raw"), /star import/],
  ["__import__ call", wrap('return __import__("os")'), /banned name: __import__/],
  ["class-hierarchy escape", wrap("return ().__class__.__bases__[0].__subclasses__()"), /dunder attribute/],
  ["function globals", wrap("return normalize.__globals__"), /dunder attribute: __globals__/],
  ["code object", wrap("return normalize.__code__"), /dunder attribute: __code__/],
  ["getattr indirection", wrap('return getattr(raw, "upper")()'), /banned name: getattr/],
  ["vars/globals", wrap("return globals()"), /banned name: globals/],
  ["eval", wrap("return eval(raw)"), /banned name: eval/],
  ["exec", wrap("exec(raw)\n    return raw"), /banned name: exec/],
  ["open", wrap('return open("/etc/passwd").read()'), /banned name: open/],
  ["compile", wrap("return compile(raw, 'x', 'eval')"), /banned name: compile/],
  ["format-string attribute traversal", wrap('return "{0.__class__}".format(raw)'), /(double underscore|banned attribute: format)/],
  ["format-string with a built-up dunder", wrap('return ("{0." + "_" * 2 + "class" + "_" * 2 + "}").format(raw)'), /banned attribute: format/],
  ["string.Formatter", "import string\n" + wrap('return string.Formatter().format("x")'), /banned (name|attribute): Formatter/],
  ["reach sys through an allowed module", "import calendar\n" + wrap("return calendar.sys.modules"), /banned attribute: sys/],
  ["reach os through an allowed module", "import re\n" + wrap("return re.os.system('x')"), /banned attribute: os/],
  ["stdout forgery", wrap("return raw.__class__"), /dunder attribute/],
  ["syntax error", "def normalize(raw:\n", /syntax error/],
  ["oversized source", wrap("return raw") + "# " + "x".repeat(9000), /too long/],
];
for (const [name, code, re] of ESCAPES) {
  test(`screen rejects: ${name}`, () => {
    const r = screen(code);
    assert.equal(r.ok, false, `should be rejected: ${code.slice(0, 60)}`);
    assert.match(r.reasons.join(" | "), re);
  });
}

test("screen allows every legitimate solution (references and baselines for all pillars)", () => {
  for (const f of FAMILY_LIST) {
    const spec = FAMILIES[f];
    for (const [label, code] of [["baseline", spec.baselineCode], ["reference", REFERENCE[f] ?? ""]] as const) {
      if (!code) continue;
      const r = screen(code, spec.extraImports);
      assert.equal(r.ok, true, `${f} ${label}: ${r.reasons.join(", ")}`);
    }
  }
});

test("an import that is allowed for one pillar is rejected for another (json: Orchestrate only)", () => {
  assert.equal(screen(REFERENCE.orchestrate, FAMILIES.orchestrate.extraImports).ok, true);
  assert.equal(screen(REFERENCE.orchestrate, []).ok, false);
});

test("ordinary Python the tasks need is NOT over-blocked: regexes, comprehensions, classes, f-strings, dicts", () => {
  const code = `import re
from collections import Counter
_PAT = re.compile(r"(\\d+)")
class Box:
    def __init__(self, v):
        self.v = v
    def __repr__(self):
        return f"Box({self.v!r})"
def normalize(raw):
    nums = [int(m) for m in _PAT.findall(raw)]
    c = Counter(nums)
    return str(sorted(c.items())) + repr(Box(len(nums)))
`;
  const r = screen(code);
  assert.equal(r.ok, true, r.reasons.join(", "));
});

// ---- the restricted runner, with the syntax-tree screen BYPASSED, to prove the second layer on its own ----
test("runner: open() does not exist for candidate code", () => {
  const out = runner(wrap('return open("/etc/hostname").read()'), ["x"]);
  assert.match(out.outputs[0].err, /NameError/);
});

test("runner: importing a non-allowed module is blocked at run time", () => {
  const out = runner("import os\n" + wrap("return raw"), ["x"]);
  assert.match(out.load_error, /ImportError: import blocked: os/);
});

test("runner: an allowed import still works", () => {
  const out = runner("import re\n" + wrap('return re.sub("a", "b", raw)'), ["banana"]);
  assert.deepEqual(out.outputs, [{ ok: "bbnbnb" }]);
});

function runnerRaw(code: string, inputs: string[]): { stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "raw-"));
  writeFileSync(join(dir, "runner.py"), RUNNER_PY);
  writeFileSync(join(dir, "candidate.py"), code);
  const r = spawnSync("python3", ["-I", join(dir, "runner.py"), dir], { input: JSON.stringify({ inputs, allowed: allowedImports() }), encoding: "utf8", timeout: 30_000 });
  return { stdout: r.stdout, stderr: r.stderr };
}

test("runner: the candidate's print() goes to stderr, so stdout carries ONLY the runner's single result line", () => {
  const { stdout, stderr } = runnerRaw(wrap('print("hello from candidate")\n    return "real"'), ["a"]);
  assert.equal(stdout.trim().split("\n").length, 1, "stdout must hold exactly one line");
  assert.doesNotMatch(stdout, /hello from candidate/);
  assert.match(stderr, /hello from candidate/);
});

test("runner: a candidate cannot forge the result by printing JSON (print goes to stderr)", () => {
  const forged = '{"outputs": [{"ok": "allow"}, {"ok": "allow"}]}';
  const out = runner(wrap(`print('${forged}')\n    return "real"`), ["a", "b"]);
  assert.deepEqual(out.outputs, [{ ok: "real" }, { ok: "real" }]);
});

test("runner: an infinite loop becomes a timeout for that input, not a hang", () => {
  const out = runner(wrap("while True:\n        pass"), ["x"]);
  assert.deepEqual(out.outputs, [{ err: "timeout" }]);
});

test("runner: a crash in the candidate is an error for that input, never a pass", () => {
  const out = runner(wrap("return 1 / 0"), ["x"]);
  assert.match(out.outputs[0].err, /ZeroDivisionError/);
});

test("runner: non-JSON-serialisable return values are errors, not passes", () => {
  const out = runner(wrap("return {1, 2}"), ["x"]);
  assert.ok("err" in out.outputs[0]);
});

test("the runner alone does NOT block dunder attribute tricks: the syntax-tree screen is what stops them (documented limit)", () => {
  const code = wrap("return str(().__class__.__name__)");
  assert.equal(screen(code).ok, false); // layer 1 catches it
  assert.deepEqual(runner(code, ["x"]).outputs, [{ ok: "tuple" }]); // layer 2 alone would not
});
