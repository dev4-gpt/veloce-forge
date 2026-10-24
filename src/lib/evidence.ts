// Tamper-evident round reports: an append-only hash chain, optionally signed with Ed25519.
// Pure functions (no database, no network) so the server and the tests share one implementation.
// scripts/verify-report.mjs re-implements the checks with node:crypto only, so a reviewer can verify a file offline
// without trusting (or even installing) this codebase.
//
// WHAT THIS PROVES: the entries in an exported file are internally consistent and in order, nothing in the middle was edited,
// removed or reordered, and (if signed) they were produced by the holder of the signing key.
// WHAT IT DOES NOT PROVE: that the sandbox really ran, or that the recorded scores are true. It is a record of what the
// server claimed. Someone who controls BOTH the database and the signing key can forge a chain. Truncating the newest
// entries is only detectable if you kept an earlier head hash.
//
// Pattern inspired by the run-patch-prove hackathon project (sealed reports); re-implemented here.
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";

export const GENESIS = "0".repeat(64);
const DOMAIN = "veloce-forge/report/v1";

/** Deterministic JSON: keys sorted at every depth, no whitespace. Rejects values that have no stable encoding. */
export function canonical(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("canonical: non-finite number");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  throw new Error("canonical: unsupported value of type " + typeof v);
}

export const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

export function entryHash(seq: number, prev: string, body: unknown): string {
  return sha256hex(`${DOMAIN}\n${seq}\n${prev}\n${canonical(body)}`);
}

// ---- bodies ----
export interface RoundBody {
  kind: "round";
  roundId: string;
  family: string;
  pillar: string;
  startedBy: string | null;
  status: string; // proposed | rejected | blocked_unsettled
  toolId: string | null;
  candidate: { sha: string; code: string } | null;
  visible: { current: number; candidate: number; total: number } | null;
  heldout: { current: number; candidate: number; total: number } | null;
  heldoutCommitment: string | null; // SHA-256 of the private held-out set used (commitment only, never its contents)
  cross: { partner: string; current: number; candidate: number; total: number } | null;
  gate: { passed: boolean; reasons: string[] } | null;
  egressBlocked: boolean | null;
  astOk: boolean | null;
  sandboxId: string | null;
  usage: { tokensIn: number | null; tokensOut: number | null; execMs: number | null };
  costMicros: number | null; // null when the usage figure was unknown (never recorded as zero)
  settlement: "settled" | "blocked_unsettled" | "released";
  eventsSha?: string | null; // digest of the stored event stream used for replay (see replay.ts); null/absent = not recorded
  payment?: { mode: "wallet" | "card_hold"; paymentIntent: string | null; holdState: string | null; capturedCents: number | null }; // who paid; informational
  at: string; // server clock; not independently attested
}

/** Pull the facts a report needs out of a round's event stream. A missing event is null (unknown), never assumed good. */
export function summariseEvents(events: readonly Record<string, unknown>[]): { sandboxId: string | null; egressBlocked: boolean | null; astOk: boolean | null } {
  let sandboxId: string | null = null;
  let egressBlocked: boolean | null = null;
  let astOk: boolean | null = null;
  for (const e of events) {
    if (e.type === "sandbox_created" && typeof e.id === "string") sandboxId = e.id;
    else if (e.type === "egress_check" && typeof e.blocked === "boolean") egressBlocked = e.blocked;
    else if (e.type === "ast_screen" && typeof e.ok === "boolean") astOk = e.ok; // last attempt wins: it is the candidate that was kept
  }
  return { sandboxId, egressBlocked, astOk };
}

/** Fresh-audit rule on counts (shared with the offline verifier): the promoted tool must score at least as well as the version it
 *  replaced on a frozen set that never took part in any promotion decision, and its held-out rate may not exceed its audit
 *  rate by more than 3/10 (a large gap means it was selected for the held-out set rather than for the task). Integer arithmetic. */
export const AUDIT_MAX_GAP_TENTHS = 3;
export function auditCountsOk(held: { pass: number; total: number }, cand: { pass: number; total: number }, prev: { pass: number; total: number }): boolean {
  if (!(held.total > 0 && cand.total > 0 && prev.total === cand.total)) return false;
  if (cand.pass < prev.pass) return false;
  return 10 * (held.pass * cand.total - cand.pass * held.total) <= AUDIT_MAX_GAP_TENTHS * held.total * cand.total;
}

export interface AuditBody {
  kind: "audit";
  toolId: string;
  family: string;
  auditSetSha: string; // commitment to the private audit set (never its contents)
  candidate: { pass: number; total: number };
  previous: { toolId: string; pass: number; total: number };
  heldout: { pass: number; total: number };
  passed: boolean;
  reasons: string[];
  egressBlocked: boolean | null;
  sandboxId: string | null;
  costMicros: number | null;
  at: string;
}

export interface DecisionBody {
  kind: "decision";
  toolId: string;
  family: string;
  decision: "approve" | "reject" | "revoke";
  shaAtDecision: string;
  reviewerId: string; // "shared-passcode" in demo mode
  at: string;
}

/** Declares tools whose rounds happened BEFORE the chain existed, so a later decision on them cannot be cross-checked against a round
 *  entry. It is appended to the chain like everything else (tamper-evident), may appear anywhere, and applies chain-wide. */
export interface EpochBody {
  kind: "epoch";
  legacyToolIds: string[];
  note: string;
  at: string;
}

export type ReportBody = RoundBody | DecisionBody | AuditBody | EpochBody;

export interface Entry {
  seq: number;
  prev: string;
  hash: string;
  body: ReportBody;
  sig?: string; // base64 Ed25519 over the hash (as UTF-8 hex text)
  kid?: string; // first 16 hex chars of SHA-256 of the SPKI public key
}

// ---- signing (optional) ----
export interface Signer {
  privateKey: KeyObject;
  publicKeyB64: string; // SPKI DER, base64
  kid: string;
}

/** REPORT_SIGNING_KEY = base64 of an Ed25519 private key in PKCS8 DER.
 *  Generate: node -e "const k=require('crypto').generateKeyPairSync('ed25519');console.log(k.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'))" */
export function loadSigner(env: NodeJS.ProcessEnv = process.env): Signer | null {
  const raw = env.REPORT_SIGNING_KEY;
  if (!raw) return null;
  const privateKey = createPrivateKey({ key: Buffer.from(raw, "base64"), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" }) as Buffer;
  return { privateKey, publicKeyB64: spki.toString("base64"), kid: createHash("sha256").update(spki).digest("hex").slice(0, 16) };
}

export function makeEntry(seq: number, prev: string, body: ReportBody, signer: Signer | null): Entry {
  const hash = entryHash(seq, prev, body);
  const e: Entry = { seq, prev, hash, body };
  if (signer) {
    e.sig = edSign(null, Buffer.from(hash, "utf8"), signer.privateKey).toString("base64");
    e.kid = signer.kid;
  }
  return e;
}

// ---- verification (same rules the offline script applies) ----
export interface VerifyOptions {
  publicKeyB64?: string; // pin a key: every entry (from signedFrom on, if set) must then carry a valid signature from it
  signedFrom?: number; // first sequence number that must be signed; earlier entries predate the key. Needs publicKeyB64
  expectHead?: string; // a head hash you saved earlier: detects truncation of newer entries
  margin?: number; // required held-out improvement for a promotion (default 2, = HELDOUT_MARGIN)
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  head: string | null;
  signed: "all" | "none" | "mixed";
  problems: string[];
}

export function verifyChain(entries: Entry[], opts: VerifyOptions = {}): VerifyResult {
  const problems: string[] = [];
  const margin = opts.margin ?? 2;
  let prev = GENESIS;
  let signedCount = 0;
  const rounds = new Map<string, RoundBody>(); // by toolId
  const decided = new Set<string>();
  const approvedTools = new Set<string>();
  const revokedTools = new Set<string>();
  const seenDecisions = new Set<string>();
  const audited = new Set<string>();
  const roundIds = new Set<string>();
  const legacy = new Set<string>(); // declared by epoch entries anywhere in the chain
  for (const e of entries) if (e.body?.kind === "epoch") for (const id of e.body.legacyToolIds ?? []) legacy.add(id);
  let pub: KeyObject | null = null;
  const signedFrom = opts.signedFrom;
  if (signedFrom !== undefined && (!Number.isInteger(signedFrom) || signedFrom < 1)) problems.push("signedFrom must be a whole number of 1 or more");
  if (signedFrom !== undefined && !opts.publicKeyB64) problems.push("signedFrom needs a pinned public key");
  if (opts.publicKeyB64) pub = createPublicKey({ key: Buffer.from(opts.publicKeyB64, "base64"), format: "der", type: "spki" });

  entries.forEach((e, i) => {
    const at = `entry #${e.seq}`;
    if (e.seq !== i + 1) problems.push(`${at}: sequence is not contiguous (expected ${i + 1})`);
    if (e.prev !== prev) problems.push(`${at}: prev hash does not match the previous entry (chain broken)`);
    let h = "";
    try {
      h = entryHash(e.seq, e.prev, e.body);
    } catch (err) {
      problems.push(`${at}: body cannot be hashed (${(err as Error).message})`);
    }
    if (h && h !== e.hash) problems.push(`${at}: stored hash does not match its content (entry was edited)`);
    prev = e.hash;

    if (e.sig) {
      signedCount++;
      if (pub) {
        const okSig = edVerify(null, Buffer.from(e.hash, "utf8"), pub, Buffer.from(e.sig, "base64"));
        if (!okSig) problems.push(`${at}: signature does not verify against the pinned key`);
      }
    } else if (pub && (signedFrom === undefined || e.seq >= signedFrom)) problems.push(`${at}: unsigned, but a public key was pinned`);

    const b = e.body;
    if (b.kind === "round") {
      if (roundIds.has(b.roundId)) problems.push(`${at}: round ${b.roundId} recorded twice`);
      roundIds.add(b.roundId);
      if (b.candidate && sha256hex(b.candidate.code) !== b.candidate.sha) problems.push(`${at}: candidate code does not match its recorded hash`);
      if (b.status === "proposed") {
        // Recompute the parts of the promotion gate that the recorded numbers allow. Per-case regression needs the
        // private pass vectors, which are deliberately not exported, so that rule is NOT re-checked here.
        const w = (m: string) => problems.push(`${at}: round ${b.roundId} is "proposed" but ${m}`);
        if (!b.candidate) w("it has no candidate");
        if (!b.gate || b.gate.passed !== true) w("its gate did not pass");
        if (!b.heldout || b.heldout.candidate < b.heldout.current + margin) w(`held-out did not improve by ${margin}`);
        if (!b.visible || b.visible.candidate < b.visible.current) w("the visible score dropped");
        if (b.cross && b.cross.candidate < b.cross.current) w("the cross-pillar end-to-end score dropped");
        if (b.egressBlocked !== true) w("outbound access was not proven blocked");
        if (b.astOk !== true) w("the syntax-tree screen did not pass");
        if (b.settlement !== "settled" || b.costMicros === null) w("the round was not settled with a known cost");
      }
      if (b.toolId && legacy.has(b.toolId)) problems.push(`${at}: tool ${b.toolId} is declared as pre-chain (legacy) but this chain has its round entry`);
      if (b.toolId && b.candidate) rounds.set(b.toolId, b);
    } else if (b.kind === "decision") {
      const r = rounds.get(b.toolId);
      if (!r && legacy.has(b.toolId)) {
        // its round happened before the chain existed: nothing to cross-check, and that is stated by an epoch entry in the chain
      } else if (!r) problems.push(`${at}: decision on ${b.toolId} has no earlier round entry`);
      else {
        if (b.shaAtDecision !== r.candidate?.sha) problems.push(`${at}: decision hash differs from the code the round produced`);
        if (r.status !== "proposed") problems.push(`${at}: decision on a tool whose round was "${r.status}", not "proposed"`);
        if (b.decision !== "revoke" && r.startedBy && r.startedBy === b.reviewerId && b.reviewerId !== "shared-passcode") {
          problems.push(`${at}: separation of duties violated (${b.reviewerId} started the round and reviewed it)`);
        }
      }
      // An EXACT repeat (same tool, decision, code hash and reviewer) is a double submit, not a second decision: tolerated. Anything
      // different, such as approve then reject or two different reviewers, is still flagged.
      const dk = `${b.toolId}|${b.decision}|${b.shaAtDecision}|${b.reviewerId}`;
      if (seenDecisions.has(dk)) {
        // duplicate submission of the same decision: nothing new to count
      } else if (b.decision === "revoke") {
        if (!approvedTools.has(b.toolId)) problems.push(`${at}: revoke of tool ${b.toolId} that was never approved`);
        if (revokedTools.has(b.toolId)) problems.push(`${at}: tool ${b.toolId} was revoked more than once`);
        revokedTools.add(b.toolId);
      } else {
        if (decided.has(b.toolId)) problems.push(`${at}: tool ${b.toolId} was decided more than once`);
        decided.add(b.toolId);
        if (b.decision === "approve") approvedTools.add(b.toolId);
      }
      seenDecisions.add(dk);
    } else if (b.kind === "epoch") {
      if (!Array.isArray(b.legacyToolIds) || b.legacyToolIds.length === 0 || b.legacyToolIds.some((x) => typeof x !== "string")) problems.push(`${at}: epoch entry without a valid legacy tool list`);
    } else if (b.kind === "audit") {
      const k = `${b.toolId}|${b.auditSetSha}`;
      if (!approvedTools.has(b.toolId)) problems.push(`${at}: audit of tool ${b.toolId} that was never approved`);
      if (audited.has(k)) problems.push(`${at}: tool ${b.toolId} audited twice against the same set`);
      audited.add(k);
      if (b.egressBlocked !== true) problems.push(`${at}: audit ran without proven blocked outbound access`);
      if (b.passed && !auditCountsOk(b.heldout, b.candidate, b.previous)) problems.push(`${at}: audit of ${b.toolId} is marked passed but its own numbers break the audit rule`);
    } else problems.push(`${at}: unknown entry kind`);
  });

  // A signed entry authenticates everything before it (each hash covers the previous one), so the pinned key only proves something if at
  // least one entry in the signed range exists.
  if (pub && signedFrom !== undefined && !entries.some((e) => e.seq >= signedFrom)) problems.push(`no entry at or after sequence ${signedFrom}, so nothing was authenticated by the pinned key`);

  if (opts.expectHead && entries.length && !entries.some((e) => e.hash === opts.expectHead)) {
    problems.push("the expected head hash is not in this chain (entries were removed or replaced)");
  } else if (opts.expectHead && !entries.length) problems.push("the chain is empty but a head hash was expected");

  return {
    ok: problems.length === 0,
    entries: entries.length,
    head: entries.length ? entries[entries.length - 1].hash : null,
    signed: signedCount === 0 ? "none" : signedCount === entries.length ? "all" : "mixed",
    problems,
  };
}
