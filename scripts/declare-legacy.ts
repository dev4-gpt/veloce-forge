// Append an `epoch` entry to the report chain declaring tools whose rounds happened BEFORE the chain existed, so the offline verifier
// can accept a decision on them that has no round entry. Writes ONE chain entry (append-only, signed if REPORT_SIGNING_KEY is set).
// Usage: npx tsx --env-file=.env --env-file=.env.local scripts/declare-legacy.ts <tool id> [<tool id> ...]
// Refuses an id that is unknown or that already has a round entry in the chain.
import { appendReport, readChain } from "../src/lib/chainStore";
import { ensureSchema, getTool } from "../src/lib/db";

async function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) throw new Error("usage: declare-legacy.ts <tool id> [<tool id> ...]");
  await ensureSchema();
  const chain = await readChain();
  for (const id of ids) {
    if (!(await getTool(id))) throw new Error(`unknown tool ${id}`);
    if (chain.some((e) => e.body.kind === "round" && e.body.toolId === id)) throw new Error(`${id} already has a round entry in the chain; it is not pre-chain`);
    if (chain.some((e) => e.body.kind === "epoch" && e.body.legacyToolIds.includes(id))) throw new Error(`${id} is already declared legacy`);
  }
  const e = await appendReport({ kind: "epoch", legacyToolIds: ids, note: "rounds that happened before the report chain existed; decisions on these tools cannot be cross-checked", at: new Date().toISOString() });
  console.log(`declared ${ids.join(", ")} as pre-chain in entry #${e.seq} (${e.hash.slice(0, 12)}...)`);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
