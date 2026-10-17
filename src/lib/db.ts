// Neon Postgres access: wallet + append-only ledger, tool library, approvals, Stripe event dedupe.
// Every money movement is one atomic SQL statement keyed by a unique idempotency key.
import { neon } from "@neondatabase/serverless";
import { FAMILIES, type Family, sha256 } from "./bench/cases";

let _sql: ReturnType<typeof neon> | null = null;
export function sql() {
  if (!_sql) {
    const url = process.env.NEON_POSTGRES_CONNECTION_STRING || process.env.DATABASE_URL;
    if (!url) throw new Error("NEON_POSTGRES_CONNECTION_STRING is not set");
    _sql = neon(url);
  }
  return _sql;
}

let schemaReady = false;
export async function ensureSchema() {
  if (schemaReady) return;
  const q = sql();
  await q`create table if not exists wallet (id int primary key, balance_micros bigint not null default 0, held_micros bigint not null default 0)`;
  await q`insert into wallet(id) values (1) on conflict do nothing`;
  await q`create table if not exists ledger (id bigserial primary key, kind text not null, amount_micros bigint not null, round_id text, idem_key text unique, note text, created_at timestamptz not null default now())`;
  await q`create table if not exists stripe_events (event_id text primary key, kind text, created_at timestamptz not null default now())`;
  await q`create table if not exists tools (id text primary key, family text not null, version int not null, code text not null, sha text not null, status text not null, visible_count int, heldout_count int, heldout_pass_json text, round_id text, rationale text, gate_json text, created_at timestamptz not null default now())`;
  await q`create table if not exists approvals (id bigserial primary key, tool_id text not null, decision text not null, sha_at_decision text not null, created_at timestamptz not null default now())`;
  await q`create table if not exists rounds (id text primary key, family text not null, status text not null, usage_json text, created_at timestamptz not null default now())`;
  schemaReady = true;
}

// ---------- wallet / ledger ----------
export async function getWallet(): Promise<{ balance: number; held: number }> {
  const r = (await sql()`select balance_micros, held_micros from wallet where id = 1`) as any[];
  return { balance: Number(r[0].balance_micros), held: Number(r[0].held_micros) };
}

/** Credit the wallet exactly once per idempotency key (Stripe session id). Returns false if already credited. */
export const LIFETIME_TOPUP_CAP_MICROS = 20_000_000; // $20 of test credits in total: a public demo must not let anyone burn the model/sandbox quota

export async function credit(idemKey: string, amountMicros: number, note: string): Promise<boolean> {
  const total = (await sql()`select coalesce(sum(amount_micros), 0) as t from ledger where kind = 'topup' and idem_key <> ${idemKey}`) as any[];
  if (Number(total[0].t) + amountMicros > LIFETIME_TOPUP_CAP_MICROS) return false;
  const r = (await sql()`
    with ins as (
      insert into ledger(kind, amount_micros, idem_key, note) values ('topup', ${amountMicros}, ${idemKey}, ${note})
      on conflict (idem_key) do nothing returning amount_micros)
    update wallet set balance_micros = balance_micros + (select coalesce(sum(amount_micros), 0) from ins)
    where id = 1 returning (select count(*) from ins) as inserted`) as any[];
  return Number(r[0]?.inserted ?? 0) > 0;
}

/** I1: reserve before any sandbox exists. Returns false (and changes nothing) if funds are insufficient. */
export async function reserve(roundId: string, cap: number): Promise<boolean> {
  const r = (await sql()`
    with w as (
      update wallet set balance_micros = balance_micros - ${cap}::bigint, held_micros = held_micros + ${cap}::bigint
      where id = 1 and balance_micros >= ${cap}::bigint returning 1),
    l as (
      insert into ledger(kind, amount_micros, round_id, idem_key)
      select 'reserve', ${cap}::bigint, ${roundId}, ${"reserve:" + roundId} from w returning id)
    select (select count(*) from w) as ok`) as any[];
  return Number(r[0]?.ok ?? 0) > 0;
}

/** Settle actual usage (<= cap) and release the remainder. Idempotent per round. */
export async function settle(roundId: string, cap: number, actual: number): Promise<boolean> {
  if (actual > cap) return false; // overrun is a blocked outcome, never clipped
  const released = cap - actual;
  const r = (await sql()`
    with s as (
      insert into ledger(kind, amount_micros, round_id, idem_key) values ('settle', ${actual}::bigint, ${roundId}, ${"settle:" + roundId})
      on conflict (idem_key) do nothing returning 1),
    rel as (
      insert into ledger(kind, amount_micros, round_id, idem_key)
      select 'release', ${released}::bigint, ${roundId}, ${"release:" + roundId} from s returning 1)
    update wallet set held_micros = held_micros - ${cap}::bigint * (select count(*) from s),
                      balance_micros = balance_micros + ${released}::bigint * (select count(*) from s)
    where id = 1 returning (select count(*) from s) as done`) as any[];
  return Number(r[0]?.done ?? 0) > 0;
}

/** I2/I3: unknown usage or failed settlement. The hold stays; the round can never be a success. */
export async function markBlocked(roundId: string, cap: number, note: string) {
  await sql()`insert into ledger(kind, amount_micros, round_id, idem_key, note) values ('blocked_unsettled', ${cap}, ${roundId}, ${"blocked:" + roundId}, ${note}) on conflict (idem_key) do nothing`;
}

export async function recordStripeEvent(eventId: string, kind: string): Promise<boolean> {
  const r = (await sql()`insert into stripe_events(event_id, kind) values (${eventId}, ${kind}) on conflict do nothing returning event_id`) as any[];
  return r.length > 0;
}

export async function latestTopupKey(): Promise<{ idem_key: string; amount_micros: number } | null> {
  const r = (await sql()`select idem_key, amount_micros from ledger where kind = 'topup' order by id desc limit 1`) as any[];
  return r[0] ? { idem_key: r[0].idem_key, amount_micros: Number(r[0].amount_micros) } : null;
}

export async function recentLedger(n = 15) {
  const r = (await sql()`select id, kind, amount_micros, round_id, idem_key, note, created_at from ledger order by id desc limit ${n}`) as any[];
  return r.map((x) => ({ ...x, id: Number(x.id), amount_micros: Number(x.amount_micros) }));
}

// ---------- tool library ----------
export interface ToolRow {
  id: string;
  family: Family;
  version: number;
  code: string;
  sha: string;
  status: "active" | "proposed" | "rejected" | "superseded" | "blocked";
  visible_count: number | null;
  heldout_count: number | null;
  heldout_pass: boolean[] | null;
  round_id: string | null;
  rationale: string | null;
  gate: { passed: boolean; reasons: string[] } | null;
  created_at: string;
}

const toTool = (r: any): ToolRow => ({
  id: r.id,
  family: r.family,
  version: Number(r.version),
  code: r.code,
  sha: r.sha,
  status: r.status,
  visible_count: r.visible_count === null ? null : Number(r.visible_count),
  heldout_count: r.heldout_count === null ? null : Number(r.heldout_count),
  heldout_pass: r.heldout_pass_json ? JSON.parse(r.heldout_pass_json) : null,
  round_id: r.round_id,
  rationale: r.rationale,
  gate: r.gate_json ? JSON.parse(r.gate_json) : null,
  created_at: String(r.created_at),
});

export async function getActive(family: Family): Promise<ToolRow> {
  let r = (await sql()`select * from tools where family = ${family} and status = 'active' limit 1`) as any[];
  if (!r.length) {
    const code = FAMILIES[family].baselineCode;
    await sql()`insert into tools(id, family, version, code, sha, status) values (${"t-" + family + "-v0"}, ${family}, 0, ${code}, ${sha256(code)}, 'active') on conflict do nothing`;
    r = (await sql()`select * from tools where family = ${family} and status = 'active' limit 1`) as any[];
  }
  return toTool(r[0]);
}

export async function setActiveHeldout(toolId: string, pass: boolean[], visible: number) {
  await sql()`update tools set heldout_pass_json = ${JSON.stringify(pass)}, heldout_count = ${pass.filter(Boolean).length}, visible_count = ${visible} where id = ${toolId}`;
}

export async function nextVersion(family: Family): Promise<number> {
  const r = (await sql()`select coalesce(max(version), 0) + 1 as v from tools where family = ${family}`) as any[];
  return Number(r[0].v);
}

export async function insertTool(t: Omit<ToolRow, "created_at">) {
  await sql()`insert into tools(id, family, version, code, sha, status, visible_count, heldout_count, heldout_pass_json, round_id, rationale, gate_json)
    values (${t.id}, ${t.family}, ${t.version}, ${t.code}, ${t.sha}, ${t.status}, ${t.visible_count}, ${t.heldout_count}, ${t.heldout_pass ? JSON.stringify(t.heldout_pass) : null}, ${t.round_id}, ${t.rationale}, ${t.gate ? JSON.stringify(t.gate) : null})`;
}

export async function getTool(id: string): Promise<ToolRow | null> {
  const r = (await sql()`select * from tools where id = ${id}`) as any[];
  return r[0] ? toTool(r[0]) : null;
}

export async function listTools(family: Family): Promise<ToolRow[]> {
  const r = (await sql()`select * from tools where family = ${family} order by version desc, created_at desc limit 12`) as any[];
  return r.map(toTool);
}

/** Approval is bound to the code hash: the caller passes the hash it reviewed, and it must equal the stored code's hash. */
export async function review(toolId: string, decision: "approve" | "reject", shaReviewed: string): Promise<{ ok: boolean; error?: string }> {
  const t = await getTool(toolId);
  if (!t) return { ok: false, error: "tool not found" };
  if (t.status !== "proposed") return { ok: false, error: `tool is ${t.status}, not proposed` };
  const actual = sha256(t.code);
  if (shaReviewed !== actual || t.sha !== actual) return { ok: false, error: "hash mismatch: the code changed after review" };
  await sql()`insert into approvals(tool_id, decision, sha_at_decision) values (${toolId}, ${decision}, ${actual})`;
  if (decision === "approve") {
    await sql()`update tools set status = 'superseded' where family = ${t.family} and status = 'active'`;
    await sql()`update tools set status = 'active' where id = ${toolId}`;
  } else {
    await sql()`update tools set status = 'rejected' where id = ${toolId}`;
  }
  return { ok: true };
}

export async function roundIsRunning(): Promise<boolean> {
  const r = (await sql()`select count(*) as n from rounds where status = 'running' and created_at > now() - interval '3 minutes'`) as any[];
  return Number(r[0].n) > 0;
}

export async function startRoundRow(id: string, family: Family) {
  await sql()`insert into rounds(id, family, status) values (${id}, ${family}, 'running')`;
}

export async function finishRoundRow(id: string, status: string, usage: unknown) {
  await sql()`update rounds set status = ${status}, usage_json = ${JSON.stringify(usage)} where id = ${id}`;
}
