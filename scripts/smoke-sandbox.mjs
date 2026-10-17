// Smoke test for the CreateOS Sandbox API: create -> exec -> stdin -> egress -> pause -> fork -> destroy.
// Usage: node --env-file=.env.local scripts/smoke-sandbox.mjs
// Prints results only; never prints the API key. Always destroys what it created.
const BASE = process.env.CREATEOS_SANDBOX_BASE_URL || "https://api.sb.createos.sh";
const KEY = process.env.CREATEOS_SANDBOX_API_KEY;
if (!KEY) {
  console.error("CREATEOS_SANDBOX_API_KEY is not set");
  process.exit(1);
}

async function api(method, path, body) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    method,
    headers: { "X-Api-Key": KEY, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, ms: Date.now() - t0, json };
}

const exec = (id, cmd, args, stdin) => api("POST", `/v1/sandboxes/${id}/exec`, { cmd, args, stdin });
const short = (v, n = 220) => JSON.stringify(v).slice(0, n);
const show = (label, r) => {
  const d = r.json?.data?.result;
  console.log(
    `${label}: HTTP ${r.status} in ${r.ms}ms` +
      (d
        ? ` | exit=${d.exit_code} exec_ms=${r.json.data.exec_ms} stdout=${JSON.stringify((d.stdout || "").slice(0, 80))} stderr=${JSON.stringify((d.stderr || "").slice(0, 120))}`
        : ` | ${short(r.json)}`),
  );
};

async function waitStatus(id, want, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const r = await api("GET", `/v1/sandboxes/${id}`);
    const s = r.json?.data?.status;
    if (s === want || s === "error") return s;
    await new Promise((res) => setTimeout(res, 2000));
  }
  return "timeout";
}

const created = [];
try {
  const who = await api("GET", "/v1/whoami");
  console.log(`whoami: HTTP ${who.status} | keys: ${Object.keys(who.json?.data || {}).join(",")}`);

  const c = await api("POST", "/v1/sandboxes", {
    shape: "s-1vcpu-1gb",
    rootfs: "devbox:1",
    name: `smoke-${Date.now()}`,
    egress: ["127.0.0.1"], // one useless entry = effectively deny-all (empty list means allow-all)
  });
  console.log(`create: HTTP ${c.status} in ${c.ms}ms | ${short(c.json, 260)}`);
  const id = c.json?.data?.id;
  if (!id) throw new Error("no sandbox id returned");
  created.push(id);

  show("python3 print", await exec(id, "python3", ["-c", "print(1+1)"]));
  show("stdin json", await exec(id, "python3", ["-c", "import sys,json; print(len(json.load(sys.stdin)))"], '["a","b","c"]'));
  show(
    "egress blocked? (expect failure)",
    await exec(id, "timeout", ["8", "python3", "-c", "import urllib.request;print(urllib.request.urlopen('https://example.com',timeout=5).status)"]),
  );
  const eg = await api("GET", `/v1/sandboxes/${id}/egress`);
  console.log(`egress read: HTTP ${eg.status} | ${short(eg.json, 160)}`);

  // Fork needs a paused source. On the free plan the concurrent cap is 1, so fork may be refused (429/402).
  await exec(id, "sh", ["-c", "echo state > /tmp/marker.txt"]);
  const p = await api("POST", `/v1/sandboxes/${id}/pause`);
  console.log(`pause: HTTP ${p.status} | ${short(p.json, 120)}`);
  console.log(`pause settled: ${await waitStatus(id, "paused")}`);
  const f = await api("POST", `/v1/sandboxes/${id}/fork`, { start_paused: false });
  console.log(`fork: HTTP ${f.status} | ${short(f.json, 260)}`);
  const forkId = f.json?.data?.id;
  if (forkId) {
    created.push(forkId);
    console.log(`fork settled: ${await waitStatus(forkId, "running")}`);
    show("fork sees marker", await exec(forkId, "cat", ["/tmp/marker.txt"]));
    const feg = await api("GET", `/v1/sandboxes/${forkId}/egress`);
    console.log(`fork egress: HTTP ${feg.status} | ${short(feg.json, 160)}`);
  }
} catch (e) {
  console.error("smoke test error:", e.message);
  process.exitCode = 1;
} finally {
  for (const sid of created.reverse()) {
    const del = await api("DELETE", `/v1/sandboxes/${sid}`);
    console.log(`destroy ${sid.slice(0, 8)}: HTTP ${del.status} | ${short(del.json, 100)}`);
  }
}
