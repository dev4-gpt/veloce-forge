// Database side of the tamper-evident report chain (the hashing and verification live in evidence.ts).
// Appends are serialised by the primary key on seq: two writers that read the same tail cannot both insert, and the loser retries.
import { canonical, GENESIS, loadSigner, makeEntry, type Entry, type ReportBody, type Signer } from "./evidence";
import { ensureSchema, sql } from "./db";

interface Row {
  seq: number | string;
  prev: string;
  body_json: string;
  hash: string;
  sig: string | null;
  kid: string | null;
}

const toEntry = (r: Row): Entry => ({ seq: Number(r.seq), prev: r.prev, hash: r.hash, body: JSON.parse(r.body_json), ...(r.sig ? { sig: r.sig, kid: r.kid ?? undefined } : {}) });

export async function readChain(): Promise<Entry[]> {
  await ensureSchema();
  const rows = (await sql()`select seq, prev, body_json, hash, sig, kid from report_chain order by seq asc`) as Row[];
  return rows.map(toEntry);
}

export async function chainHead(): Promise<{ seq: number; hash: string } | null> {
  await ensureSchema();
  const r = (await sql()`select seq, hash from report_chain order by seq desc limit 1`) as { seq: number | string; hash: string }[];
  return r[0] ? { seq: Number(r[0].seq), hash: r[0].hash } : null;
}

/** Append one report. Retries when another writer took the same sequence number. Throws if it cannot append. */
export async function appendReport(body: ReportBody, signer: Signer | null = loadSigner()): Promise<Entry> {
  await ensureSchema();
  for (let attempt = 0; attempt < 6; attempt++) {
    const head = await chainHead();
    const entry = makeEntry((head?.seq ?? 0) + 1, head?.hash ?? GENESIS, body, signer);
    try {
      await sql()`insert into report_chain(seq, prev, body_json, hash, sig, kid) values (${entry.seq}, ${entry.prev}, ${canonical(body)}, ${entry.hash}, ${entry.sig ?? null}, ${entry.kid ?? null})`;
      return entry;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).toLowerCase();
      if (!(msg.includes("duplicate key") || (e as { code?: string })?.code === "23505")) throw e;
    }
  }
  throw new Error("could not append to the report chain (too much contention)");
}
