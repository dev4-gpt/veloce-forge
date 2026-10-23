#!/usr/bin/env node
// Offline verifier for a Veloce Forge report chain. Needs only Node 18+; imports nothing from this repo, so you do not
// have to trust the application to check its evidence. (src/lib/evidence.ts holds the server's copy of these rules; a test
// makes sure the two agree.)
//
// Usage:
//   curl -H "x-demo-passcode: ..." https://<app>/api/evidence -o evidence.json
//   node scripts/verify-report.mjs evidence.json [--pubkey <base64 SPKI>] [--head <hash you saved earlier>] [--margin 2]
//
// Exit code: 0 = verified, 1 = problems found, 2 = bad usage / unreadable file.
//
// This proves the file is internally consistent and (with --pubkey) signed by the key you trust. It does NOT prove the
// sandbox ran or that the scores are true, and it cannot see entries newer than the file unless you kept an older --head.
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";

const GENESIS = "0".repeat(64);
const DOMAIN = "veloce-forge/report/v1";

function canonical(v) {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (typeof v === "object") return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  throw new Error("unsupported value");
}
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const entryHash = (seq, prev, body) => sha256(`${DOMAIN}\n${seq}\n${prev}\n${canonical(body)}`);

// Fresh-audit rule on counts: the promoted tool must score at least as well as the version it replaced on a frozen set that never
// took part in any promotion decision, and its held-out rate may not exceed its audit rate by more than 3/10.
const AUDIT_MAX_GAP_TENTHS = 3;
function auditCountsOk(held, cand, prev) {
  if (!(held.total > 0 && cand.total > 0 && prev.total === cand.total)) return false;
  if (cand.pass < prev.pass) return false;
  return 10 * (held.pass * cand.total - cand.pass * held.total) <= AUDIT_MAX_GAP_TENTHS * held.total * cand.total;
}

export function verify(entries, { pubkey, head, margin = 2 } = {}) {
  const problems = [];
  let prev = GENESIS;
  let signed = 0;
  const rounds = new Map();
  const decided = new Set();
  const approvedTools = new Set();
  const revokedTools = new Set();
  const audited = new Set();
  const seen = new Set();
  const legacy = new Set(); // tools declared as pre-chain by epoch entries anywhere in the chain
  for (const e of entries) if (e.body?.kind === "epoch") for (const id of e.body.legacyToolIds ?? []) legacy.add(id);
  const pub = pubkey ? createPublicKey({ key: Buffer.from(pubkey, "base64"), format: "der", type: "spki" }) : null;

  entries.forEach((e, i) => {
    const at = `entry #${e.seq}`;
    if (e.seq !== i + 1) problems.push(`${at}: sequence is not contiguous (expected ${i + 1})`);
    if (e.prev !== prev) problems.push(`${at}: prev hash does not match the previous entry (chain broken)`);
    let h = "";
    try {
      h = entryHash(e.seq, e.prev, e.body);
    } catch (err) {
      problems.push(`${at}: body cannot be hashed (${err.message})`);
    }
    if (h && h !== e.hash) problems.push(`${at}: stored hash does not match its content (entry was edited)`);
    prev = e.hash;

    if (e.sig) {
      signed++;
      if (pub && !edVerify(null, Buffer.from(String(e.hash), "utf8"), pub, Buffer.from(e.sig, "base64"))) problems.push(`${at}: signature does not verify against the pinned key`);
    } else if (pub) problems.push(`${at}: unsigned, but a public key was pinned`);

    const b = e.body ?? {};
    if (b.kind === "round") {
      if (seen.has(b.roundId)) problems.push(`${at}: round ${b.roundId} recorded twice`);
      seen.add(b.roundId);
      if (b.candidate && sha256(b.candidate.code) !== b.candidate.sha) problems.push(`${at}: candidate code does not match its recorded hash`);
      if (b.status === "proposed") {
        const w = (m) => problems.push(`${at}: round ${b.roundId} is "proposed" but ${m}`);
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
        // its round happened before the chain existed: nothing to cross-check, and an epoch entry in the chain says so
      } else if (!r) problems.push(`${at}: decision on ${b.toolId} has no earlier round entry`);
      else {
        if (b.shaAtDecision !== r.candidate?.sha) problems.push(`${at}: decision hash differs from the code the round produced`);
        if (r.status !== "proposed") problems.push(`${at}: decision on a tool whose round was "${r.status}", not "proposed"`);
        if (b.decision !== "revoke" && r.startedBy && r.startedBy === b.reviewerId && b.reviewerId !== "shared-passcode") problems.push(`${at}: separation of duties violated (${b.reviewerId} started the round and reviewed it)`);
      }
      if (b.decision === "revoke") {
        if (!approvedTools.has(b.toolId)) problems.push(`${at}: revoke of tool ${b.toolId} that was never approved`);
        if (revokedTools.has(b.toolId)) problems.push(`${at}: tool ${b.toolId} was revoked more than once`);
        revokedTools.add(b.toolId);
      } else {
        if (decided.has(b.toolId)) problems.push(`${at}: tool ${b.toolId} was decided more than once`);
        decided.add(b.toolId);
        if (b.decision === "approve") approvedTools.add(b.toolId);
      }
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

  if (head && !entries.some((e) => e.hash === head)) problems.push(entries.length ? "the expected head hash is not in this chain (entries were removed or replaced)" : "the chain is empty but a head hash was expected");
  return { ok: problems.length === 0, entries: entries.length, head: entries.at(-1)?.hash ?? null, signed: signed === 0 ? "none" : signed === entries.length ? "all" : "mixed", problems };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

// Only run the CLI when executed directly (the test imports verify()).
if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) {
    console.error("usage: node scripts/verify-report.mjs evidence.json [--pubkey <base64>] [--head <hash>] [--margin 2]");
    process.exit(2);
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(doc.entries)) throw new Error("no entries array");
  } catch (e) {
    console.error("cannot read evidence file:", e.message);
    process.exit(2);
  }
  const pubkey = arg("--pubkey");
  const res = verify(doc.entries, { pubkey, head: arg("--head"), margin: arg("--margin") ? Number(arg("--margin")) : 2 });
  console.log(`entries checked : ${res.entries}`);
  console.log(`head hash       : ${res.head ?? "(empty chain)"}   <- save this; a later export must still contain it`);
  console.log(`signatures      : ${res.signed}${pubkey ? " (checked against the key you pinned)" : doc.publicKey ? " (NOT checked: the key in the file proves nothing unless you pin it with --pubkey)" : ""}`);
  if (res.signed === "none") console.log("note            : unsigned chain = consistency only. Whoever can write the database could have rebuilt it.");
  if (res.problems.length) {
    console.log(`\nFAILED: ${res.problems.length} problem(s)`);
    for (const p of res.problems) console.log("  - " + p);
    process.exit(1);
  }
  console.log("\nVERIFIED: hash chain intact, promotion rules consistent with the recorded numbers.");
  console.log("Not proven: that the sandbox really ran, that the scores are true, or the per-case regression rule (private pass vectors are not exported).");
}
