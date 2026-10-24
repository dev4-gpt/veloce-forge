// Read-only logical backup: every table in the public schema to one JSON file (SELECTs only, never migrates).
// Usage: npx tsx --env-file=.env --env-file=.env.local scripts/backup-db.ts
// Output goes to notes/backups/ (git-ignored). The file contains private data (code, ledger, held-out sets, token HASHES): keep it private.
// This is a data backup for rollback, not a Neon branch; a Neon branch is still the faster restore.
import { mkdirSync, writeFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { sql } from "../src/lib/db";

async function main() {
  const url = process.env.NEON_POSTGRES_CONNECTION_STRING || process.env.DATABASE_URL;
  if (!url) throw new Error("no database connection string in the environment");
  const q = sql();
  const tables = ((await q`select table_name from information_schema.tables where table_schema = 'public' order by 1`) as { table_name: string }[]).map((r) => r.table_name);
  const dump: Record<string, unknown[]> = {};
  for (const t of tables) {
    if (!/^[a-z_]+$/.test(t)) throw new Error(`unexpected table name ${t}`);
    // names come from information_schema and are checked above; a tagged template cannot parameterise identifiers
    dump[t] = (await (neon(url) as unknown as { query: (t: string) => Promise<unknown[]> }).query(`select * from ${t}`)) as unknown[];
  }
  mkdirSync("notes/backups", { recursive: true });
  const file = `notes/backups/db-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), tables: dump }, null, 1), { mode: 0o600 });
  console.log(file);
  for (const t of tables) console.log(`  ${t}: ${dump[t].length} row(s)`);
}
main().catch((e) => {
  console.error("backup failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
