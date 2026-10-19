// Run: npx tsx --test tests/gate.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { FAMILIES, FAMILY_LIST } from "../src/lib/bench/cases";
import { existsSync, readFileSync } from "node:fs";
import { decideGate, egressBlocked, feedbackSafeReasons, scoreOutputs, staticScreen } from "../src/lib/gate";

const ok = staticScreen("import re\ndef normalize(raw):\n    return raw.strip()\n");

test("static screen allows plain stdlib code", () => {
  assert.equal(ok.ok, true);
});

test("static screen rejects forbidden imports and calls", () => {
  assert.equal(staticScreen("import os\ndef normalize(raw):\n    return raw").ok, false);
  assert.equal(staticScreen("from subprocess import run\ndef normalize(raw):\n    return raw").ok, false);
  assert.equal(staticScreen("def normalize(raw):\n    return eval(raw)").ok, false);
  assert.equal(staticScreen("def normalize(raw):\n    open('/etc/passwd')").ok, false);
  assert.equal(staticScreen("x = 1").ok, false); // no normalize()
});

test("static screen allows re.compile and flags only the builtin compile/exec/open", () => {
  assert.equal(staticScreen("import re\nP = re.compile(r'x')\ndef normalize(raw):\n    return P.sub('', raw)").ok, true);
  assert.equal(staticScreen("def normalize(raw):\n    return compile(raw, 'x', 'eval')").ok, false);
  assert.equal(staticScreen("def normalize(raw):\n    pos.append(1)\n    return raw").ok, true); // 'pos.' is not 'os.'
});

test("gate passes only with margin, no regression and no visible drop", () => {
  const cur = { visibleCount: 2, heldoutPass: [true, false, false, false] };
  const better = { visibleCount: 6, heldoutPass: [true, true, true, false] };
  assert.equal(decideGate(cur, better, ok).passed, true);
  const smallWin = { visibleCount: 6, heldoutPass: [true, true, false, false] };
  assert.equal(decideGate(cur, smallWin, ok).passed, false); // below margin
  const regress = { visibleCount: 6, heldoutPass: [false, true, true, true] };
  const r = decideGate(cur, regress, ok);
  assert.equal(r.passed, false);
  assert.match(r.reasons.join(" "), /regression/);
  const visibleDrop = { visibleCount: 1, heldoutPass: [true, true, true, true] };
  assert.equal(decideGate(cur, visibleDrop, ok).passed, false);
});

test("a screen failure blocks promotion even with a perfect score", () => {
  const bad = staticScreen("import os\ndef normalize(raw):\n    return raw");
  const cur = { visibleCount: 0, heldoutPass: [false, false] };
  const perfect = { visibleCount: 6, heldoutPass: [true, true] };
  assert.equal(decideGate(cur, perfect, bad).passed, false);
});

test("a hardcoding candidate passes the feedback cases but fails unseen cases and is rejected", () => {
  const spec = FAMILIES.dates;
  const feedback = [...spec.visible, ...spec.field];
  const unseen = [{ input: "x1", expected: "a" }, { input: "x2", expected: "b" }, { input: "x3", expected: "c" }];
  const seen = scoreOutputs(feedback, { outputs: feedback.map((c) => ({ ok: c.expected })) });
  const heldOut = scoreOutputs(unseen, { outputs: unseen.map(() => ({ err: "ValueError: nope" })) });
  assert.equal(seen.count, feedback.length);
  assert.equal(heldOut.count, 0);
  const cur = { visibleCount: 1, heldoutPass: unseen.map(() => false) };
  assert.equal(decideGate(cur, { visibleCount: seen.count, heldoutPass: heldOut.pass }, ok).passed, false);
});

test("scoring is type strict and handles wrong output counts", () => {
  const cases = [{ input: "a", expected: 5 }];
  assert.equal(scoreOutputs(cases, { outputs: [{ ok: "5" }] }).count, 0);
  assert.equal(scoreOutputs(cases, { outputs: [{ ok: 5 }] }).count, 1);
  assert.equal(scoreOutputs(cases, { outputs: [] }).count, 0);
  assert.equal(scoreOutputs(cases, { load_error: "boom" }).count, 0);
});

test("public benchmark is well formed and contains NO held-out cases", () => {
  for (const f of FAMILY_LIST) {
    assert.equal("heldout" in FAMILIES[f], false, `${f}: held-out cases must not live in the public spec`);
    const all = [...FAMILIES[f].visible, ...FAMILIES[f].field].map((c) => c.input);
    assert.equal(new Set(all).size, all.length, `${f}: duplicate feedback inputs`);
  }
});

test("a private held-out file, when present locally, does not overlap the public cases", () => {
  if (!existsSync("private/heldout.json")) return; // not available in CI or on a fresh clone
  const priv = JSON.parse(readFileSync("private/heldout.json", "utf8"));
  for (const f of FAMILY_LIST) {
    const seen = new Set([...FAMILIES[f].visible, ...FAMILIES[f].field].map((c) => c.input));
    for (const c of priv[f]) assert.equal(seen.has(c.input), false, `${f}: ${c.input} overlaps the public feedback set`);
  }
});

test("feedback to the model never carries held-out counts or regression details", () => {
  const reasons = ["held-out 3 does not beat current 1 by 2", "regression on 2 held-out case(s) the current tool passed", "static screen: forbidden token: socket"];
  const safe = feedbackSafeReasons(reasons).join(" ");
  assert.match(safe, /static screen: forbidden token: socket/);
  assert.doesNotMatch(safe, /held-out \d|regression on \d|beat current/);
  assert.deepEqual(feedbackSafeReasons(["static screen: x"]), ["static screen: x"]);
});

test("egress verdict fails closed: only an explicit REACHED counts as open", () => {
  assert.equal(egressBlocked(1, ""), true); // request failed
  assert.equal(egressBlocked(124, ""), true); // timeout
  assert.equal(egressBlocked(0, ""), true); // ran but proved nothing
  assert.equal(egressBlocked(0, "REACHED\n"), false); // internet reachable -> NOT blocked
});
