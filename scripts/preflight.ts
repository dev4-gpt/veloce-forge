// Read-only deploy preflight. It changes nothing: no migration, no insert, no secret printed (only set/unset and counts).
// Point it at the target environment with the env file you would deploy with:
//   npx tsx --env-file=.env.local scripts/preflight.ts
// Exit code 1 if any BLOCK is found.
import { existsSync, readFileSync } from "node:fs";
import { sql } from "../src/lib/db";
import { evaluate, gatherDb, gatherEnv, gatherFiles } from "../src/lib/preflight";

const readJson = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

async function main() {
  const env = gatherEnv();
  let db;
  try {
    db = await gatherDb(sql());
  } catch (e) {
    db = await gatherDb(async () => {
      throw e;
    });
  }
  const files = gatherFiles(readJson("private/heldout.json"), readJson("private/audit.json"));
  const checks = evaluate(env, db, files);
  const tag = { block: "BLOCK", warn: "WARN ", ok: "ok   " } as const;
  for (const c of checks) console.log(`${tag[c.level]}  ${c.item}: ${c.detail}`);
  const blocks = checks.filter((c) => c.level === "block").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  console.log(`\n${blocks} blocking, ${warns} warning(s), ${checks.length - blocks - warns} ok. Read-only: nothing was changed.`);
  process.exit(blocks ? 1 : 0);
}
main().catch((e) => {
  console.error("preflight failed:", e instanceof Error ? e.message : e);
  process.exit(2);
});
