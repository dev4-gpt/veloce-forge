// Seed the PRIVATE held-out sets into the database from a git-ignored file.
// Usage: npx tsx --env-file=.env --env-file=.env.local scripts/seed-heldout.ts [heldout path] [audit path]
//        (defaults private/heldout.json and private/audit.json)
import { existsSync, readFileSync } from "node:fs";
import { FAMILY_LIST } from "../src/lib/bench/cases";
import { auditKey } from "../src/lib/audit";
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
  // Frozen fresh-audit sets (optional): private/audit.json, same shape {family: [{input, expected}]}. They never take part in a
  // promotion decision; each is scored once after a promotion (see src/lib/audit.ts).
  const auditPath = process.argv[3] ?? "private/audit.json";
  if (existsSync(auditPath)) {
    const audit = JSON.parse(readFileSync(auditPath, "utf8"));
    for (const f of FAMILY_LIST) {
      const cases = audit[f];
      if (!Array.isArray(cases) || cases.length < 5) {
        console.log(`audit:${f} skipped (need at least 5 cases in ${auditPath})`);
        continue;
      }
      const overlap = cases.filter((c: { input: string }) => data[f].some((h: { input: string }) => h.input === c.input));
      if (overlap.length) throw new Error(`audit:${f} shares ${overlap.length} input(s) with the held-out set; an audit set must be disjoint`);
      const r = await seedHeldoutSet(auditKey(f), cases);
      console.log(`audit:${f}`, cases.length, "cases", r.changed ? "stored" : "unchanged", r.sha.slice(0, 12));
    }
  } else console.log(`no ${auditPath}: promoted tools will stay unaudited`);
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
