// Run: npx tsx --test tests/pillars.test.ts
// Proves the three pillar benchmarks are well formed: the reference solution scores 100% on every case (so labels follow the
// written rules), while each naive baseline leaves real room to improve. Python runs locally; no network, no sandbox quota.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { FAMILIES, type Case, type Family } from "../src/lib/bench/cases";
import { REFERENCE } from "./references";

function runPython(code: string, inputs: string[]): { ok?: unknown; err?: string }[] {
  const harness = `import sys, json
payload = json.load(sys.stdin)
ns = {}
exec(payload["code"], ns)
out = []
for x in payload["inputs"]:
    try:
        out.append({"ok": ns["normalize"](x)})
    except BaseException as e:
        out.append({"err": type(e).__name__})
print(json.dumps(out))`;
  const r = spawnSync("python3", ["-I", "-c", harness], { input: JSON.stringify({ code, inputs }), encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}
const score = (code: string, cases: Case[]) => runPython(code, cases.map((c) => c.input)).filter((o, i) => "ok" in o && o.ok === cases[i].expected).length;
const PILLARS: Family[] = ["command", "context", "govern"];
const privateSet = existsSync("private/heldout.json") ? JSON.parse(readFileSync("private/heldout.json", "utf8")) : null;

for (const f of PILLARS) {
  const spec = FAMILIES[f];
  test(`${f}: the reference solution scores 100% on visible and field cases (labels match the written rules)`, () => {
    const cases = [...spec.visible, ...spec.field];
    assert.equal(score(REFERENCE[f], cases), cases.length);
  });
  test(`${f}: the reference solution scores 100% on the private held-out set (when present locally)`, { skip: !privateSet }, () => {
    assert.equal(score(REFERENCE[f], privateSet[f]), privateSet[f].length);
  });
  test(`${f}: the naive baseline leaves real room to improve, and is not already perfect`, () => {
    const all = [...spec.visible, ...spec.field];
    const base = score(spec.baselineCode, all);
    assert.ok(base < all.length * 0.7, `${f}: baseline scores ${base}/${all.length}`);
    if (privateSet) assert.ok(score(spec.baselineCode, privateSet[f]) <= privateSet[f].length * 0.5);
  });
  test(`${f}: has its own role, pillar and a rule-bearing instruction`, () => {
    assert.equal(spec.pillar, f);
    assert.ok(spec.agentRole.includes("pillar agent"));
    assert.ok(spec.instruction.length > 300);
  });
  test(`${f}: the reference solution passes the product's own static screen`, async () => {
    const { staticScreen } = await import("../src/lib/gate");
    assert.equal(staticScreen(REFERENCE[f], spec.extraImports).ok, true);
  });
}

test("the three pillar agents use different roles and different held-out sets", () => {
  const roles = new Set(PILLARS.map((f) => FAMILIES[f].agentRole));
  assert.equal(roles.size, 3);
  if (privateSet) {
    const inputs = new Set(PILLARS.flatMap((f) => privateSet[f].map((c: Case) => c.input)));
    assert.equal(inputs.size, 30);
  }
});
