// Run: npx tsx --test tests/auth.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPasscode } from "../src/lib/auth";

const req = (h?: string) => new Request("http://x/api", { method: "POST", headers: h ? { "x-demo-passcode": h } : {} });

test("fails closed when no passcode is configured", () => {
  const r = checkPasscode(req("anything"), {} as NodeJS.ProcessEnv);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 503);
});
test("rejects missing and wrong passcodes, accepts the right one", () => {
  const env = { DEMO_PASSCODE: "s3cret" } as unknown as NodeJS.ProcessEnv;
  assert.equal(checkPasscode(req(), env).ok, false);
  assert.equal(checkPasscode(req("nope"), env).ok, false);
  assert.equal(checkPasscode(req("s3cret"), env).ok, true);
});
