// List reviewer identities, or disable one (a disabled identity's token stops working at once; the row stays for the audit trail).
// Usage: npx tsx --env-file=.env --env-file=.env.local scripts/disable-reviewer.ts            (list)
//        npx tsx --env-file=.env --env-file=.env.local scripts/disable-reviewer.ts <id>      (disable)
import { ensureSchema, sql } from "../src/lib/db";

async function main() {
  await ensureSchema();
  const id = process.argv[2];
  if (id) {
    const r = (await sql()`update reviewers set disabled = true where id = ${id} and disabled = false returning name, role`) as { name: string; role: string }[];
    console.log(r.length ? `disabled ${r[0].role} "${r[0].name}" (${id})` : `nothing to do: ${id} is unknown or already disabled`);
  }
  const rows = (await sql()`select id, name, role, disabled, created_at from reviewers order by created_at`) as { id: string; name: string; role: string; disabled: boolean; created_at: string }[];
  for (const x of rows) console.log(`${x.disabled ? "disabled" : "active  "}  ${x.role.padEnd(8)} ${x.id}  ${x.name}`);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
