// Neon Postgres access: wallet + append-only ledger, tool library, approvals, Stripe event dedupe.
// Every money movement is one atomic SQL statement keyed by a unique idempotency key.
import { randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { FAMILIES, type Family, sha256 } from "./bench/cases";

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
let _sql: SqlTag | null = null;

/** Tests inject an in-process Postgres (PGlite) here; production uses Neon over HTTP. */
export function __setSqlForTests(fn: SqlTag | null) {
  _sql = fn;
  schemaReady = false;
}

export function sql(): SqlTag {
  if (!_sql) {
    const url = process.env.NEON_POSTGRES_CONNECTION_STRING || process.env.DATABASE_URL;
    if (!url) throw new Error("NEON_POSTGRES_CONNECTION_STRING is not set");
    _sql = neon(url) as unknown as SqlTag;
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
  await q`create table if not exists heldout_sets (family text primary key, sha text not null, cases_json text not null, updated_at timestamptz not null default now())`;
  await q`create table if not exists rounds (id text primary key, family text not null, status text not null, usage_json text, created_at timestamptz not null default now())`;
  await q`create table if not exists reviewers (id text primary key, name text not null, role text not null check (role in ('operator','reviewer','admin')), token_hash text not null unique, disabled boolean not null default false, created_at timestamptz not null default now())`;
  await q`alter table approvals add column if not exists reviewer_id text`;
  // The held-out set commitment (heldout_sets.sha) a proposal was scored against; review() refuses an approval if the family's set has since changed.
  await q`alter table tools add column if not exists heldout_sha text`;
  await q`alter table rounds add column if not exists started_by text`;
  // The index below fails if two rows are 'running' (possible on a database that ran the older code, which had no guard).
  // Keep only the newest running row, and expire any older than 3 minutes, so a first start on an old database cannot fail.
  await q`update rounds set status = 'abandoned' where status = 'running' and (created_at < now() - interval '3 minutes' or id <> (select id from rounds where status = 'running' order by created_at desc, id desc limit 1))`;
  await q`create unique index if not exists one_running_round on rounds ((1)) where status = 'running'`;
  // Tamper-evident report chain (see evidence.ts). body_json is the canonical text that was hashed; rows are never updated or deleted.
  await q`create table if not exists report_chain (seq bigint primary key, prev text not null, body_json text not null, hash text not null unique, sig text, kid text, created_at timestamptz not null default now())`;
  await q`create or replace function report_chain_immutable() returns trigger as $f$ begin raise exception 'report_chain is append-only'; end $f$ language plpgsql`;
  await q`do $d$ begin if not exists (select 1 from pg_trigger where tgname = 'report_chain_no_change') then create trigger report_chain_no_change before update or delete on report_chain for each row execute function report_chain_immutable(); end if; end $d$`;
  // Recorded event streams for replay (see replay.ts). Immutable like the chain; their digest is sealed into the round's chain entry.
  await q`create table if not exists round_events (round_id text primary key, family text not null, status text not null, events_json text not null, digest text not null, created_at timestamptz not null default now())`;
  await q`do $d$ begin if not exists (select 1 from pg_trigger where tgname = 'round_events_no_change') then create trigger round_events_no_change before update or delete on round_events for each row execute function report_chain_immutable(); end if; end $d$`;
  // Fresh audits: one immutable result per promoted tool and audit set (see audit.ts).
  await q`create table if not exists audits (tool_id text not null, set_sha text not null, family text not null, status text not null check (status in ('passed','failed')), cand_pass_json text not null, prev_tool_id text not null, prev_pass_json text not null, heldout_pass int not null, heldout_total int not null, reasons_json text not null, sandbox_id text, cost_micros bigint, created_at timestamptz not null default now(), primary key (tool_id, set_sha))`;
  await q`do $d$ begin if not exists (select 1 from pg_trigger where tgname = 'audits_no_change') then create trigger audits_no_change before update or delete on audits for each row execute function report_chain_immutable(); end if; end $d$`;
  // Stripe manual-capture holds (test mode), one per round paid by card. Every state change is a compare-and-set in cardHold.ts.
  await q`create table if not exists card_holds (round_id text primary key, payment_intent text unique, amount_cents int not null, status text not null check (status in ('authorizing','authorized','capturing','captured','releasing','released','failed','unresolved')), captured_cents int, note text, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
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
  status: "active" | "proposed" | "rejected" | "superseded" | "blocked" | "revoked";
  visible_count: number | null;
  heldout_count: number | null;
  heldout_pass: boolean[] | null;
  heldout_sha: string | null; // commitment of the held-out set this version was scored against (null = unknown, e.g. made before this was recorded)
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
  heldout_sha: r.heldout_sha ?? null,
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
  await sql()`insert into tools(id, family, version, code, sha, status, visible_count, heldout_count, heldout_pass_json, heldout_sha, round_id, rationale, gate_json)
    values (${t.id}, ${t.family}, ${t.version}, ${t.code}, ${t.sha}, ${t.status}, ${t.visible_count}, ${t.heldout_count}, ${t.heldout_pass ? JSON.stringify(t.heldout_pass) : null}, ${t.heldout_sha}, ${t.round_id}, ${t.rationale}, ${t.gate ? JSON.stringify(t.gate) : null})`;
}

export async function getTool(id: string): Promise<ToolRow | null> {
  const r = (await sql()`select * from tools where id = ${id}`) as any[];
  return r[0] ? toTool(r[0]) : null;
}

export async function listTools(family: Family): Promise<ToolRow[]> {
  const r = (await sql()`select * from tools where family = ${family} order by version desc, created_at desc limit 12`) as any[];
  return r.map(toTool);
}

export const STALE_ERROR = "scored against a different held-out set; re-run the round";

/** A proposal is stale when it was not scored against the held-out set currently stored for its family (or we cannot tell).
 *  Approving it would skip the current set, so review() refuses; reject is still allowed. */
export function isStaleProposal(t: Pick<ToolRow, "status" | "heldout_sha">, currentSetSha: string | null): boolean {
  return t.status === "proposed" && (!t.heldout_sha || t.heldout_sha !== currentSetSha);
}

/** Approval is bound to the code hash: the caller passes the hash it reviewed; it must equal the hash recomputed from the
 *  stored code AND match the row, and the approval record, the supersede of the old active tool and the promotion
 *  happen in ONE statement, so no partial state can be left behind. */
export async function review(toolId: string, decision: "approve" | "reject", shaReviewed: string, reviewerId: string | null = null): Promise<{ ok: boolean; error?: string }> {
  const t = await getTool(toolId);
  if (!t) return { ok: false, error: "tool not found" };
  if (t.status !== "proposed") return { ok: false, error: `tool is ${t.status}, not proposed` };
  const actual = sha256(t.code);
  if (shaReviewed !== actual || t.sha !== actual) return { ok: false, error: "hash mismatch: the code changed after review" };
  // Separation of duties: the identity that started the round that produced this tool cannot approve or reject it.
  if (reviewerId && t.round_id) {
    const starter = (await sql()`select started_by from rounds where id = ${t.round_id}`) as { started_by: string | null }[];
    if (starter[0]?.started_by && starter[0].started_by === reviewerId) {
      return { ok: false, error: "separation of duties: the person who started this round cannot review its result" };
    }
  }
  const approve = decision === "approve";
  if (approve) {
    const cur = (await sql()`select sha from heldout_sets where family = ${t.family}`) as { sha: string }[];
    if (isStaleProposal(t, cur[0]?.sha ?? null)) return { ok: false, error: STALE_ERROR };
  }
  // The held-out check is repeated inside the statement so a set re-seeded between the check above and here cannot slip through.
  const r = (await sql()`
    with cand as (select id, family from tools where id = ${toolId} and status = 'proposed' and sha = ${actual}
      and (not ${approve}::boolean or heldout_sha = (select sha from heldout_sets where heldout_sets.family = tools.family))),
    appr as (insert into approvals(tool_id, decision, sha_at_decision, reviewer_id) select id, ${decision}::text, ${actual}::text, ${reviewerId}::text from cand returning 1),
    sup as (update tools set status = 'superseded' where ${approve}::boolean and status = 'active' and family = (select family from cand) and exists (select 1 from cand) returning 1),
    act as (update tools set status = case when ${approve}::boolean then 'active' else 'rejected' end where id in (select id from cand) returning 1)
    select (select count(*) from cand) as n`) as any[];
  return Number(r[0]?.n ?? 0) > 0 ? { ok: true } : { ok: false, error: "tool changed state during review" };
}

/** Atomically claim the single "running" slot. Stale rows (older than 3 minutes) are expired first so a crashed
 *  round cannot block the system forever. A unique partial index makes concurrent claims impossible. */
export async function tryStartRound(id: string, family: Family, startedBy: string | null = null): Promise<boolean> {
  await sql()`update rounds set status = 'abandoned' where status = 'running' and created_at < now() - interval '3 minutes'`;
  try {
    await sql()`insert into rounds(id, family, status, started_by) values (${id}, ${family}, 'running', ${startedBy})`;
    return true;
  } catch (e) {
    if (String((e as Error)?.message ?? e).toLowerCase().includes("duplicate key") || (e as { code?: string })?.code === "23505") return false;
    throw e;
  }
}

export async function finishRoundRow(id: string, status: string, usage: unknown) {
  await sql()`update rounds set status = ${status}, usage_json = ${JSON.stringify(usage)} where id = ${id}`;
}

// ---------- private held-out sets (never in the public repo) ----------
export type HeldoutKey = Family | "e2e" | `audit:${Family}`;

export interface HeldoutSet {
  family: HeldoutKey;
  sha: string;
  cases: { input: string; expected: string | number }[];
}

export async function getHeldoutSet(family: HeldoutKey): Promise<HeldoutSet | null> {
  const r = (await sql()`select sha, cases_json from heldout_sets where family = ${family}`) as any[];
  return r[0] ? { family, sha: r[0].sha, cases: JSON.parse(r[0].cases_json) } : null;
}

/** Store a held-out set. If it differs from what was stored, old per-case pass vectors refer to a burned set, so clear them. */
export async function seedHeldoutSet(family: HeldoutKey, cases: HeldoutSet["cases"]): Promise<{ changed: boolean; sha: string }> {
  const json = JSON.stringify(cases);
  const sha = sha256(json);
  const cur = (await sql()`select sha from heldout_sets where family = ${family}`) as any[];
  if (cur[0]?.sha === sha) return { changed: false, sha };
  await sql()`insert into heldout_sets(family, sha, cases_json) values (${family}, ${sha}, ${json}) on conflict (family) do update set sha = excluded.sha, cases_json = excluded.cases_json, updated_at = now()`;
  await sql()`update tools set heldout_pass_json = null, heldout_count = null where family = ${family}`;
  return { changed: true, sha };
}

// ---------- reviewer identities ----------
export type Role = "operator" | "reviewer" | "admin";
export interface ReviewerRow {
  id: string;
  name: string;
  role: Role;
}

/** Create a reviewer. The token is returned ONCE and only its SHA-256 is stored. */
export async function createReviewer(name: string, role: Role): Promise<{ id: string; token: string }> {
  const token = randomBytes(24).toString("base64url");
  const id = "u-" + randomBytes(5).toString("hex");
  await sql()`insert into reviewers(id, name, role, token_hash) values (${id}, ${name}, ${role}, ${sha256(token)})`;
  return { id, token };
}

export async function findReviewerByToken(token: string): Promise<ReviewerRow | null> {
  const r = (await sql()`select id, name, role from reviewers where token_hash = ${sha256(token)} and disabled = false`) as ReviewerRow[];
  return r[0] ?? null;
}

export async function countReviewers(): Promise<number> {
  const r = (await sql()`select count(*) as n from reviewers where disabled = false`) as { n: number }[];
  return Number(r[0].n);
}
