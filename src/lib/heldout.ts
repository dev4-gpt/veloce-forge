// Server-only loader for the private held-out sets. Fails closed: with no configured set, a round refuses to run
// (it never falls back to any public cases).
import type { Family } from "./bench/cases";
import { ensureSchema, getHeldoutSet, type HeldoutSet } from "./db";

export async function loadHeldout(family: Family): Promise<HeldoutSet> {
  await ensureSchema();
  const set = await getHeldoutSet(family);
  if (!set || set.cases.length === 0) {
    throw new Error(`the held-out set for "${family}" is not configured on the server; refusing to run (fail closed)`);
  }
  return set;
}
