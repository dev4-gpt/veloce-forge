// Read-only readiness checks for a deploy. Nothing here writes, migrates or prints a secret value: the database gatherer runs
// SELECTs only (and never ensureSchema, so pointing it at production cannot change production).
import { createPrivateKey } from "node:crypto";
import { providerWarnings } from "./llm";

export type Level = "block" | "warn" | "ok";
export interface Check {
  level: Level;
  item: string;
  detail: string;
}

export const FAMILIES = ["dates", "money", "durations", "command", "context", "govern", "orchestrate"] as const;

export interface EnvFacts {
  present: Record<string, boolean>; // by variable name; values are never kept
  stripeKeyIsTest: boolean | null; // null when unset
  passcodeLength: number;
  signingKey: "absent" | "valid" | "invalid";
  cardPolicy: string | null;
  providerCount: number;
  llmWarnings: string[]; // misspelled or half-configured model providers (see providerWarnings in llm.ts)
}

export interface DbFacts {
  reachable: boolean;
  error?: string;
  tables: string[];
  runningRounds: number;
  reviewers: { total: number; roles: Record<string, number> } | null;
  heldoutSets: Record<string, number>; // key -> number of cases
  heldoutShas: Record<string, string>; // key -> commitment of the stored set
  tools: { id: string; family: string; status: string; heldoutCount: number | null; heldoutSha: string | null }[];
  wallet: { balance: number; held: number } | null;
  chainLength: number | null;
  openHolds: number | null;
}

export interface FileFacts {
  heldout: Record<string, number> | null; // null = file missing
  audit: Record<string, number> | null;
  overlaps: string[]; // families whose audit inputs also appear in the held-out file
}

export function gatherEnv(env: NodeJS.ProcessEnv = process.env): EnvFacts {
  const names = ["CREATEOS_SANDBOX_API_KEY", "GEMINI_API_KEY", "NEON_POSTGRES_CONNECTION_STRING", "DATABASE_URL", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "DEMO_PASSCODE", "REPORT_SIGNING_KEY", "OPENROUTER_API_KEY", "NVIDIA_API_KEY"];
  const present = Object.fromEntries(names.map((n) => [n, Boolean(env[n])]));
  const key = env.STRIPE_SECRET_KEY;
  let signingKey: EnvFacts["signingKey"] = "absent";
  if (env.REPORT_SIGNING_KEY) {
    try {
      const k = createPrivateKey({ key: Buffer.from(env.REPORT_SIGNING_KEY, "base64"), format: "der", type: "pkcs8" });
      signingKey = k.asymmetricKeyType === "ed25519" ? "valid" : "invalid";
    } catch {
      signingKey = "invalid";
    }
  }
  return {
    present,
    stripeKeyIsTest: key ? key.startsWith("sk_test_") || key.startsWith("rk_test_") : null,
    passcodeLength: (env.DEMO_PASSCODE ?? "").length,
    signingKey,
    cardPolicy: env.CARD_CAPTURE_POLICY ?? null,
    providerCount: 1 + (env.OPENROUTER_API_KEY ? 1 : 0) + (env.NVIDIA_API_KEY ? 1 : 0),
    llmWarnings: providerWarnings(env),
  };
}

type Q = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

/** SELECT-only. Missing tables are reported, never created. */
export async function gatherDb(q: Q): Promise<DbFacts> {
  const empty: DbFacts = { reachable: false, tables: [], runningRounds: 0, reviewers: null, heldoutSets: {}, heldoutShas: {}, tools: [], wallet: null, chainLength: null, openHolds: null };
  try {
    const tables = ((await q`select table_name from information_schema.tables where table_schema = 'public'`) as { table_name: string }[]).map((r) => r.table_name);
    const has = (t: string) => tables.includes(t);
    const out: DbFacts = { ...empty, reachable: true, tables };
    if (has("rounds")) out.runningRounds = Number(((await q`select count(*) as n from rounds where status = 'running'`) as { n: number }[])[0].n);
    if (has("reviewers")) {
      const rows = (await q`select role, count(*) as n from reviewers where disabled = false group by role`) as { role: string; n: number }[];
      out.reviewers = { total: rows.reduce((a, r) => a + Number(r.n), 0), roles: Object.fromEntries(rows.map((r) => [r.role, Number(r.n)])) };
    }
    if (has("heldout_sets")) {
      const rows = (await q`select family, sha, cases_json from heldout_sets`) as { family: string; sha: string; cases_json: string }[];
      out.heldoutSets = Object.fromEntries(rows.map((r) => [r.family, (JSON.parse(r.cases_json) as unknown[]).length]));
      out.heldoutShas = Object.fromEntries(rows.map((r) => [r.family, r.sha]));
    }
    if (has("tools")) {
      // heldout_sha only exists after the upgrade; a not-yet-upgraded database means every proposal is unrecorded (stale).
      const hasSha = ((await q`select 1 as x from information_schema.columns where table_schema = 'public' and table_name = 'tools' and column_name = 'heldout_sha'`) as unknown[]).length > 0;
      const rows = (hasSha
        ? await q`select id, family, status, heldout_count, heldout_sha from tools`
        : await q`select id, family, status, heldout_count, null::text as heldout_sha from tools`) as { id: string; family: string; status: string; heldout_count: number | null; heldout_sha: string | null }[];
      out.tools = rows.map((r) => ({ id: r.id, family: r.family, status: r.status, heldoutCount: r.heldout_count === null ? null : Number(r.heldout_count), heldoutSha: r.heldout_sha ?? null }));
    }
    if (has("wallet")) {
      const r = (await q`select balance_micros, held_micros from wallet where id = 1`) as { balance_micros: number; held_micros: number }[];
      if (r[0]) out.wallet = { balance: Number(r[0].balance_micros), held: Number(r[0].held_micros) };
    }
    if (has("report_chain")) out.chainLength = Number(((await q`select count(*) as n from report_chain`) as { n: number }[])[0].n);
    if (has("card_holds")) out.openHolds = Number(((await q`select count(*) as n from card_holds where status in ('authorizing','capturing','releasing','unresolved')`) as { n: number }[])[0].n);
    return out;
  } catch (e) {
    return { ...empty, error: (e instanceof Error ? e.message : String(e)).slice(0, 160) };
  }
}

export function gatherFiles(heldout: unknown, audit: unknown): FileFacts {
  const counts = (d: unknown) =>
    d && typeof d === "object" ? Object.fromEntries(Object.entries(d as Record<string, unknown>).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])) : null;
  const overlaps: string[] = [];
  if (heldout && audit && typeof heldout === "object" && typeof audit === "object") {
    for (const f of FAMILIES) {
      const h = new Set(((heldout as Record<string, { input: string }[]>)[f] ?? []).map((c) => c.input));
      for (const c of (audit as Record<string, { input: string }[]>)[f] ?? []) if (h.has(c.input)) overlaps.push(f);
    }
  }
  return { heldout: counts(heldout), audit: counts(audit), overlaps };
}

export function evaluate(env: EnvFacts, db: DbFacts, files: FileFacts): Check[] {
  const out: Check[] = [];
  const add = (level: Level, item: string, detail: string) => out.push({ level, item, detail });

  // ---- environment ----
  for (const n of ["CREATEOS_SANDBOX_API_KEY", "GEMINI_API_KEY", "STRIPE_SECRET_KEY", "DEMO_PASSCODE"]) {
    env.present[n] ? add("ok", n, "set") : add("block", n, "not set; the app needs it");
  }
  env.present.NEON_POSTGRES_CONNECTION_STRING || env.present.DATABASE_URL ? add("ok", "database connection string", "set") : add("block", "database connection string", "neither NEON_POSTGRES_CONNECTION_STRING nor DATABASE_URL is set");
  if (env.stripeKeyIsTest === false) add("block", "Stripe key mode", "STRIPE_SECRET_KEY is not a test-mode key; the app refuses it and so does every hold/top-up route");
  else if (env.stripeKeyIsTest) add("ok", "Stripe key mode", "test-mode key");
  env.present.STRIPE_WEBHOOK_SECRET ? add("ok", "STRIPE_WEBHOOK_SECRET", "set") : add("warn", "STRIPE_WEBHOOK_SECRET", "not set; top-up webhooks cannot be verified");
  if (env.present.DEMO_PASSCODE && env.passcodeLength < 10) add("warn", "DEMO_PASSCODE", `only ${env.passcodeLength} characters; it protects spending and approvals and has been shared in chat, so rotate it`);
  if (env.signingKey === "invalid") add("block", "REPORT_SIGNING_KEY", "set but not a valid base64 PKCS8 Ed25519 key; every report append would fail to sign");
  else if (env.signingKey === "absent") add("warn", "REPORT_SIGNING_KEY", "not set: the report chain will be unsigned (consistency only, anyone who can write the database could rebuild it)");
  else add("ok", "REPORT_SIGNING_KEY", "valid Ed25519 key");
  if (env.cardPolicy && env.cardPolicy !== "always" && env.cardPolicy !== "on_green") add("warn", "CARD_CAPTURE_POLICY", `"${env.cardPolicy}" is not recognised and will behave as "always"`);
  for (const w of env.llmWarnings ?? []) add("warn", "LLM_PROVIDERS", w);
  if (env.providerCount < 2) add("warn", "model providers", "only Gemini is configured; one rate-limit or outage stops every round (add OPENROUTER_API_KEY or NVIDIA_API_KEY)");

  // ---- database ----
  if (!db.reachable) {
    add("block", "database", `not reachable${db.error ? ": " + db.error : ""}`);
  } else {
    add("ok", "database", `reachable, ${db.tables.length} table(s) present`);
    if (db.runningRounds > 1) add("warn", "stale running rounds", `${db.runningRounds} rows are 'running'; the first start will mark all but the newest as abandoned (needed to create the one-round index)`);
    const cfg = (k: string) => (db.heldoutSets[k] ?? 0) >= 5;
    const missingDb = FAMILIES.filter((f) => !cfg(f));
    const missingFile = missingDb.filter((f) => (files.heldout?.[f] ?? 0) < 5);
    if (missingDb.length === 0) add("ok", "held-out sets in database", `all ${FAMILIES.length} families seeded`);
    else if (missingFile.length === 0) add("warn", "held-out sets in database", `not yet seeded for: ${missingDb.join(", ")} (the local file has them; run the seed script BEFORE the first round, rounds refuse to run without them)`);
    else add("block", "held-out sets", `missing in the database AND in private/heldout.json for: ${missingFile.join(", ")}`);
    if (!cfg("e2e") && (files.heldout?.e2e ?? 0) < 5) add("block", "sealed cross-pillar set (e2e)", "missing in the database and in private/heldout.json; command and govern rounds refuse to run");
    else if (!cfg("e2e")) add("warn", "sealed cross-pillar set (e2e)", "not yet seeded in the database (the local file has it)");
    const missingAudit = FAMILIES.filter((f) => (db.heldoutSets[`audit:${f}`] ?? 0) < 5);
    if (missingAudit.length === 0) add("ok", "audit sets in database", "all seeded");
    else add("warn", "audit sets", `not seeded for: ${missingAudit.join(", ")}; promoted tools in those families stay unaudited`);

    if (db.reviewers && db.reviewers.total > 0) {
      const r = db.reviewers.roles;
      const canRun = (r.operator ?? 0) + (r.admin ?? 0) > 0;
      const canReview = (r.reviewer ?? 0) + (r.admin ?? 0) > 0;
      if (!canRun || !canReview) add("block", "reviewers", `the shared passcode no longer works once any reviewer exists, and the current roles (${JSON.stringify(r)}) cannot ${!canRun ? "start rounds" : "approve tools"}: the system would be locked`);
      else if (db.reviewers.total < 2) add("warn", "reviewers", "one identity only: the person who starts a round cannot approve its result (separation of duties), so nothing can be promoted");
      else add("ok", "reviewers", `${db.reviewers.total} active identities with ${JSON.stringify(r)}`);
    } else add("warn", "reviewers", "none yet: the shared passcode is in force (demo mode). Create operator + reviewer identities last, because the passcode stops working as soon as the first one exists");

    const proposed = db.tools.filter((t) => t.status === "proposed");
    // Same rule as review(): a proposal is approvable only if it was scored against the set stored now. Seeding new sets makes the rest stale too.
    const stale = proposed.filter((t) => !t.heldoutSha || t.heldoutSha !== db.heldoutShas[t.family]);
    if (stale.length) add("warn", "pending proposals", `${stale.map((t) => t.id).join(", ")} ${stale.length === 1 ? "was" : "were"} not scored against the held-out set stored now (or no set was recorded), so approving ${stale.length === 1 ? "it is" : "them is"} refused. Reject or re-run before deploy; seeding changed sets makes any other pending proposal stale too`);
    else if (proposed.length) add("warn", "pending proposals", `${proposed.map((t) => t.id).join(", ")} await review; seeding changed held-out sets would make ${proposed.length === 1 ? "it" : "them"} stale (approval refused)`);
    const promoted = db.tools.filter((t) => t.status === "active" && !t.id.endsWith("-v0"));
    if (promoted.length) add("warn", "tools promoted under the old regime", `${promoted.map((t) => t.id).join(", ")}: their held-out standing will be re-measured on the first round with the new sets; run a fresh audit on them afterwards`);
    if (db.wallet) {
      if (db.wallet.held > 0) add("warn", "wallet", `${db.wallet.held} micro-dollars are held (unsettled round); resolve before deploy`);
      else if (db.wallet.balance < 500_000) add("warn", "wallet", `balance is only ${(db.wallet.balance / 1e6).toFixed(3)} USD; each round and each audit spends some`);
      else add("ok", "wallet", `${(db.wallet.balance / 1e6).toFixed(3)} USD available, nothing held`);
    }
    if (db.openHolds) add("warn", "card holds", `${db.openHolds} hold(s) need attention (capturing/releasing/unresolved)`);
    db.chainLength === null ? add("ok", "report chain", "not created yet; it starts empty at first start (rounds before it have no sealed report)") : add("ok", "report chain", `${db.chainLength} entries`);
  }

  // ---- local private files ----
  if (!files.heldout) add("warn", "private/heldout.json", "not found on this machine; it exists only here, so back it up before anything else");
  else {
    const short = FAMILIES.filter((f) => (files.heldout![f] ?? 0) < 5);
    short.length ? add("block", "private/heldout.json", `fewer than 5 cases for: ${short.join(", ")}`) : add("ok", "private/heldout.json", "all families have at least 5 cases");
  }
  if (!files.audit) add("warn", "private/audit.json", "not found on this machine; audits will be skipped until audit sets are seeded");
  else {
    const short = FAMILIES.filter((f) => (files.audit![f] ?? 0) < 5);
    short.length ? add("warn", "private/audit.json", `fewer than 5 cases for: ${short.join(", ")}`) : add("ok", "private/audit.json", "all families have at least 5 cases");
  }
  if (files.overlaps.length) add("block", "audit/held-out overlap", `audit inputs also appear in the held-out file for: ${[...new Set(files.overlaps)].join(", ")}`);
  return out;
}
