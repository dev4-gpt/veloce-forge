// Replay of RECORDED real runs. A round's event stream is stored when the round finishes; replay plays that stored stream
// back with its original pacing. A replay never starts a sandbox, never calls a model and never touches the wallet, and every
// line it produces carries replay:true so no client can mistake it for a live run.
//
// Integrity: the digest of the stored stream is sealed into that round's tamper-evident chain entry (eventsSha), and replay
// recomputes it and says whether it still matches. Limits: only rounds run after this feature existed are replayable, and the
// seal shows the stored stream was not edited afterwards, not that the live run it came from was honest.
import { canonical, sha256hex, type Entry } from "./evidence";
import { ensureSchema, sql } from "./db";

export interface TimedEvent {
  t: number; // milliseconds since the round started
  e: Record<string, unknown>;
}

export const eventsDigest = (events: TimedEvent[]) => sha256hex(canonical(events));

export interface Recording {
  roundId: string;
  family: string;
  status: string;
  events: TimedEvent[];
  digest: string; // as stored
  recordedAt: string;
}

/** Store a finished round's events once. Returns the digest to seal into the chain. Idempotent per round. */
export async function saveRoundEvents(roundId: string, family: string, status: string, events: TimedEvent[]): Promise<string> {
  await ensureSchema();
  const digest = eventsDigest(events);
  await sql()`insert into round_events(round_id, family, status, events_json, digest) values (${roundId}, ${family}, ${status}, ${JSON.stringify(events)}, ${digest}) on conflict (round_id) do nothing`;
  // If a recording already exists (idempotent retry) return the digest that is actually stored, not the new one.
  const stored = (await sql()`select digest from round_events where round_id = ${roundId}`) as { digest: string }[];
  return stored[0]?.digest ?? digest;
}

export async function loadRecording(roundId: string): Promise<Recording | null> {
  await ensureSchema();
  const r = (await sql()`select round_id, family, status, events_json, digest, created_at from round_events where round_id = ${roundId}`) as {
    round_id: string; family: string; status: string; events_json: string; digest: string; created_at: string;
  }[];
  if (!r[0]) return null;
  return { roundId: r[0].round_id, family: r[0].family, status: r[0].status, events: JSON.parse(r[0].events_json), digest: r[0].digest, recordedAt: String(r[0].created_at) };
}

export interface RecordingSummary {
  roundId: string;
  family: string;
  status: string;
  recordedAt: string;
  eventCount: number;
}

export async function listRecordings(limit = 20): Promise<RecordingSummary[]> {
  await ensureSchema();
  const rows = (await sql()`select round_id, family, status, created_at, events_json from round_events order by created_at desc limit ${limit}`) as {
    round_id: string; family: string; status: string; created_at: string; events_json: string;
  }[];
  return rows.map((r) => ({ roundId: r.round_id, family: r.family, status: r.status, recordedAt: String(r.created_at), eventCount: (JSON.parse(r.events_json) as unknown[]).length }));
}

export type Integrity =
  | { state: "matches_sealed_report"; seq: number }
  | { state: "mismatch"; reason: string }
  | { state: "not_sealed"; reason: string };

/** Recompute the stream's digest and compare it with the stored digest and with the digest sealed in the chain. */
export function checkIntegrity(rec: Recording, chain: Entry[]): Integrity {
  const actual = eventsDigest(rec.events);
  if (actual !== rec.digest) return { state: "mismatch", reason: "the stored events no longer match the digest saved with them" };
  const entry = chain.find((e) => e.body.kind === "round" && e.body.roundId === rec.roundId);
  if (!entry || entry.body.kind !== "round") return { state: "not_sealed", reason: "no sealed report exists for this round" };
  const sealed = entry.body.eventsSha;
  if (!sealed) return { state: "not_sealed", reason: "the sealed report for this round does not carry an events digest" };
  if (sealed !== actual) return { state: "mismatch", reason: `the events differ from the digest sealed in report #${entry.seq}` };
  return { state: "matches_sealed_report", seq: entry.seq };
}

export interface ReplayStep {
  delayMs: number; // wait this long before sending the line
  line: Record<string, unknown>;
}

export const REPLAY_NOTICE = "REPLAY of a recorded run. Nothing is running now: no sandbox, no model call, no money moves.";

export interface PlanOptions {
  speed?: number; // 1 = original pace; clamped to 0.5..8
  maxGapMs?: number; // long silences (e.g. waiting for the model) are shortened to this before the speed is applied
}

/** Turn a recording into the lines a replay stream sends. Pure: no timers, no I/O. */
export function planReplay(rec: Recording, integrity: Integrity, opts: PlanOptions = {}): ReplayStep[] {
  const speed = Math.min(8, Math.max(0.5, Number.isFinite(opts.speed) ? (opts.speed as number) : 1));
  const maxGap = opts.maxGapMs ?? 1500;
  const steps: ReplayStep[] = [
    {
      delayMs: 0,
      line: {
        type: "replay_start", replay: true, notice: REPLAY_NOTICE, roundId: rec.roundId, family: rec.family, status: rec.status,
        recordedAt: rec.recordedAt, eventCount: rec.events.length, eventsSha: rec.digest, integrity,
      },
    },
  ];
  let prevT = 0;
  for (const { t, e } of rec.events) {
    if (e.type === "replay_start" || e.type === "replay_end") continue; // a recording must not be able to forge the replay frame
    const gap = Math.min(Math.max(0, t - prevT), maxGap);
    prevT = Math.max(prevT, t);
    steps.push({ delayMs: Math.round(gap / speed), line: { ...e, replay: true } });
  }
  steps.push({ delayMs: 0, line: { type: "replay_end", replay: true, notice: REPLAY_NOTICE, roundId: rec.roundId } });
  return steps;
}
