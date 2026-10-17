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
