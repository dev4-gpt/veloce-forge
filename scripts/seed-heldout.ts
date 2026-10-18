// Seed the PRIVATE held-out sets into the database from a git-ignored file.
// Usage: npx tsx --env-file=.env --env-file=.env.local scripts/seed-heldout.ts [path]   (default private/heldout.json)
import { readFileSync } from "node:fs";
import { FAMILY_LIST } from "../src/lib/bench/cases";
import { ensureSchema, seedHeldoutSet } from "../src/lib/db";

async function main() {
  const path = process.argv[2] ?? "private/heldout.json";
  const data = JSON.parse(readFileSync(path, "utf8"));
  await ensureSchema();
  if (Array.isArray(data.e2e) && data.e2e.length >= 5) {
    const r = await seedHeldoutSet("e2e", data.e2e);
    console.log("e2e (sealed Command->Govern set)", data.e2e.length, "cases", r.changed ? "stored" : "unchanged", r.sha.slice(0, 12));
  }
  for (const f of FAMILY_LIST) {
    const cases = data[f];
    if (!Array.isArray(cases) || cases.length < 5) throw new Error(`${f}: need at least 5 held-out cases in ${path}`);
    const r = await seedHeldoutSet(f, cases);
    console.log(f, cases.length, "cases", r.changed ? "stored (old pass vectors cleared)" : "unchanged", r.sha.slice(0, 12));
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
