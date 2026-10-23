// Minimal CreateOS Sandbox REST client (server-side only; the key never reaches the browser).
// Docs: https://createos.sh/docs/Sandbox/REST-API
const BASE = () => process.env.CREATEOS_SANDBOX_BASE_URL || "https://api.sb.createos.sh";

// The API has no deny-all value (an empty list means allow-all), so one useless entry approximates it.
export const LOCKED_EGRESS = ["127.0.0.1"];

export class SandboxError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function call(method: string, path: string, body?: unknown, raw?: Uint8Array): Promise<{ status: number; json: any }> {
  const key = process.env.CREATEOS_SANDBOX_API_KEY;
  if (!key) throw new SandboxError("CREATEOS_SANDBOX_API_KEY is not set", 500);
  const headers: Record<string, string> = { "X-Api-Key": key };
  headers["Content-Type"] = raw === undefined ? "application/json" : "application/octet-stream";
  const res = await fetch(BASE() + path, {
    method,
    headers,
    body: raw !== undefined ? (raw as unknown as BodyInit) : body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  if (res.status >= 400) {
    const detail = typeof json?.data === "string" ? json.data : json?.message || JSON.stringify(json).slice(0, 200);
    throw new SandboxError(`${method} ${path} -> ${res.status}: ${detail}`, res.status);
  }
  return { status: res.status, json };
}

export interface Sandbox {
  id: string;
  spawnMs: number;
}

export async function createSandbox(name: string, egress: string[] = LOCKED_EGRESS): Promise<Sandbox> {
  const { json } = await call("POST", "/v1/sandboxes", { shape: "s-1vcpu-1gb", rootfs: "devbox:1", name, egress });
  return { id: json.data.id, spawnMs: Number(json.data.spawn_ms ?? 0) };
}

export async function destroySandbox(id: string): Promise<void> {
  await call("DELETE", `/v1/sandboxes/${id}`);
}

export async function upload(id: string, path: string, content: string): Promise<void> {
  await call("PUT", `/v1/sandboxes/${id}/files?path=${encodeURIComponent(path)}`, undefined, new TextEncoder().encode(content));
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  execMs: number | null; // null = usage unknown; never treat as zero
}

export async function exec(id: string, cmd: string, args: string[], stdin?: string): Promise<ExecResult> {
  const { json } = await call("POST", `/v1/sandboxes/${id}/exec`, { cmd, args, stdin });
  const r = json?.data?.result;
  const ms = json?.data?.exec_ms;
  return {
    exitCode: Number(r?.exit_code ?? -1),
    stdout: String(r?.stdout ?? ""),
    stderr: String(r?.stderr ?? ""),
    execMs: typeof ms === "number" ? ms : null,
  };
}

export async function listSandboxes(): Promise<{ id: string; name: string; status: string }[]> {
  const { json } = await call("GET", "/v1/sandboxes?limit=50");
  return (json?.data?.data ?? []).map((s: any) => ({ id: s.id, name: s.name, status: s.status }));
}

// ---------- leaked sandbox cleanup ----------
// A round the platform kills (function time limit, crash) never reaches its `finally`, so its sandbox keeps running and, on the free
// plan (one concurrent sandbox), blocks every later round. Our sandboxes are named vf-<3 letters>-<base36 millisecond time>; the time
// is in the name, so age can be read without trusting any other field.
export const STALE_SANDBOX_MS = 6 * 60 * 1000; // a round cannot legitimately run longer than the 300 s function limit
const OURS = /^vf-[a-z]{3}-([0-9a-z]{6,12})$/;

/** Ids of sandboxes that are ours, still running, and older than maxAgeMs. Anything not named like ours is never returned. */
export function staleSandboxIds(list: { id: string; name: string; status: string }[], now: number, maxAgeMs = STALE_SANDBOX_MS): string[] {
  return list.flatMap((s) => {
    const m = OURS.exec(s.name ?? "");
    if (!m || s.status === "destroyed") return [];
    const created = parseInt(m[1], 36);
    return Number.isFinite(created) && now - created > maxAgeMs ? [s.id] : [];
  });
}

export interface ReapDeps {
  create: (name: string, egress?: string[]) => Promise<Sandbox>;
  list: () => Promise<{ id: string; name: string; status: string }[]>;
  destroy: (id: string) => Promise<void>;
  now: () => number;
}

/** createSandbox, but when the concurrent-sandbox quota is hit, destroy OUR stale leftovers and try once more. */
export async function createSandboxReaping(name: string, egress: string[] = LOCKED_EGRESS, deps: ReapDeps = { create: createSandbox, list: listSandboxes, destroy: destroySandbox, now: Date.now }): Promise<Sandbox> {
  try {
    return await deps.create(name, egress);
  } catch (e) {
    if (!(e instanceof SandboxError) || e.status !== 429 || !/concurrent/i.test(e.message)) throw e;
    const stale = staleSandboxIds(await deps.list(), deps.now());
    if (stale.length === 0) throw e; // the running one is recent: a real round may be using it, so do not touch it
    for (const id of stale) await deps.destroy(id).catch(() => {});
    return deps.create(name, egress);
  }
}
