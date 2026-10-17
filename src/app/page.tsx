"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Hist = { id: string; version: number; status: string; heldout: number | null; visible: number | null; sha: string; rationale: string | null; gate: { passed: boolean; reasons: string[] } | null; code?: string };
type Fam = { family: string; title: string; heldoutTotal: number; feedbackTotal: number; heldoutCommitment: string; activeId: string; activeVersion: number; activeHeldout: number | null; history: Hist[] };
type State = { wallet: { balance: number; held: number }; families: Fam[]; ledger: { id: number; kind: string; amount_micros: number; round_id: string | null; idem_key: string | null; note: string | null }[] };
type Ev = { type: string; [k: string]: any };

const usd = (m: number) => `$${(m / 1_000_000).toFixed(3)}`;
const chip: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  proposed: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  rejected: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
  blocked: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
  superseded: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

function describe(e: Ev): string {
  switch (e.type) {
    case "reserved": return `Reserved ${usd(e.capMicros)} before any sandbox exists`;
    case "refused": return `Refused: ${e.reason}. ${e.detail ?? ""}`;
    case "sandbox_created": return `Sandbox ${String(e.id).slice(0, 12)} created in ${Math.round(e.spawnMs)} ms. Egress allowlist: ${e.egress?.join(", ")} (outbound blocked)`;
    case "baseline": return `Current tool: ${e.visible}/${e.visibleTotal} feedback cases, held-out ${e.heldout}/${e.heldoutTotal}`;
    case "visible_failures": return `${e.count} failing feedback case(s) shown to the agent (held-out cases are never shown)`;
    case "candidate": return `Candidate ${e.attempt} from ${e.model}: ${e.rationale}`;
    case "scores": return `Candidate ${e.attempt} scored: feedback ${e.visible}/${e.visibleTotal}, held-out ${e.heldout}/${e.heldoutTotal} (was ${e.previousHeldout})`;
    case "gate": return e.passed ? `Gate ${e.attempt}: PASSED. Waiting for human approval` : `Gate ${e.attempt}: REJECTED. ${(e.reasons as string[]).join("; ")}`;
    case "settled": return `Settled ${usd(e.actualMicros)}; released ${usd(e.releasedMicros)}`;
    case "blocked_unsettled": return `BLOCKED: ${e.reason}`;
    case "sandbox_destroyed": return `Sandbox destroyed`;
    case "result": return `Round result: ${e.status}`;
    case "error": return `Error: ${e.message}`;
    default: return e.type;
  }
}

export default function Home() {
  const [state, setState] = useState<State | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const timeline = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/state", { cache: "no-store" });
    if (r.ok) setState(await r.json());
  }, []);

  useEffect(() => {
    const sid = new URLSearchParams(window.location.search).get("session_id");
    (async () => {
      if (sid) {
        const r = await fetch("/api/topup/confirm", { method: "POST", body: JSON.stringify({ session_id: sid }) });
        const j = await r.json();
        setNotice(r.ok ? (j.credited ? "Credits added (Stripe test mode)." : "That payment was already credited; nothing added.") : `Top-up failed: ${j.error}`);
        window.history.replaceState({}, "", "/");
      }
      await refresh();
    })();
  }, [refresh]);

  useEffect(() => { timeline.current?.scrollTo({ top: timeline.current.scrollHeight }); }, [events]);

  async function topup() {
    const r = await fetch("/api/topup", { method: "POST" });
    const j = await r.json();
    if (j.url) window.location.href = j.url;
    else setNotice(j.error ?? "Could not start Checkout");
  }

  async function demoCredits() {
    const r = await fetch("/api/topup/demo", { method: "POST" });
    const j = await r.json();
    setNotice(j.credited ? "Added $5 of demo credits (not a payment)." : "Demo credits were already claimed today, or the lifetime cap is reached.");
    refresh();
  }

  async function replay() {
    const r = await fetch("/api/webhook/replay", { method: "POST" });
    const j = await r.json();
    setNotice(r.ok ? (j.credited ? "Replay credited again (unexpected!)" : `Replayed webhook: duplicate ignored, balance unchanged at ${usd(j.balanceAfter)}.`) : j.error);
    refresh();
  }

  async function run(family: string, opts: { cheat?: boolean; simulateMissingUsage?: boolean } = {}) {
    setRunning(true);
    setEvents([]);
    setNotice(null);
    try {
      const res = await fetch("/api/rounds", { method: "POST", body: JSON.stringify({ family, ...opts }) });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        setEvents([{ type: "error", message: j.error ?? `HTTP ${res.status}` }]);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) if (l.trim()) setEvents((p) => [...p, JSON.parse(l)]);
      }
    } finally {
      setRunning(false);
      refresh();
    }
  }

  async function reviewTool(id: string, sha: string, decision: "approve" | "reject") {
    const r = await fetch(`/api/tools/${id}/review`, { method: "POST", body: JSON.stringify({ decision, sha }) });
    const j = await r.json();
    setNotice(r.ok ? (decision === "approve" ? "Approved and promoted. The library now uses this version." : "Rejected.") : `Review refused: ${j.error}`);
    refresh();
  }

  const proposals = state?.families.flatMap((f) => f.history.filter((h) => h.status === "proposed").map((h) => ({ ...h, family: f.title }))) ?? [];

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Veloce Forge</h1>
          <p className="text-sm text-zinc-500">Self-improving agents that cannot promote themselves. Test mode · synthetic data · built for CreateOS × Stripe Projects.</p>
        </div>
        <div className="flex items-center gap-3 rounded-lg border border-zinc-200 px-4 py-2 text-sm dark:border-zinc-800">
          <div><div className="text-xs text-zinc-500">Balance</div><div className="font-mono text-base">{state ? usd(state.wallet.balance) : "…"}</div></div>
          <div><div className="text-xs text-zinc-500">Held</div><div className="font-mono text-base">{state ? usd(state.wallet.held) : "…"}</div></div>
          <button onClick={topup} className="rounded-md bg-indigo-600 px-3 py-1.5 text-white hover:bg-indigo-500" title="Stripe Checkout in test mode; no real charge">Add $5 credits (Stripe test)</button>
          <button onClick={demoCredits} className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900" title="No card. Labelled demo credits, once per day, not a payment.">Claim $5 demo credits</button>
          <button onClick={replay} className="rounded-md border border-zinc-300 px-3 py-1.5 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900" title="Re-deliver the last Stripe payment event. It must be ignored.">Replay webhook</button>
        </div>
      </header>

      {notice && <div className="mb-4 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-100">{notice}</div>}

      <section className="grid gap-4 md:grid-cols-3">
        {state?.families.map((f) => {
          const pct = f.activeHeldout === null ? 0 : (f.activeHeldout / f.heldoutTotal) * 100;
          return (
            <div key={f.family} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <div className="flex items-baseline justify-between">
                <h2 className="font-medium">{f.title}</h2>
                <span className="font-mono text-xs text-zinc-500">v{f.activeVersion}</span>
              </div>
              <div className="mt-2 text-xs text-zinc-500">Held-out pass rate (hidden cases)</div>
              <div className="mt-1 h-2 rounded bg-zinc-100 dark:bg-zinc-800"><div className="h-2 rounded bg-emerald-500" style={{ width: `${pct}%` }} /></div>
              <div className="mt-1 font-mono text-sm">{f.activeHeldout === null ? "not measured yet" : `${f.activeHeldout}/${f.heldoutTotal}`}</div>
              <div className="mt-2 text-[11px] text-zinc-500" title={f.heldoutCommitment}>held-out commitment sha256 {f.heldoutCommitment.slice(0, 12)}…</div>
              <ul className="mt-3 space-y-1 text-xs">
                {f.history.slice(0, 4).map((h) => (
                  <li key={h.id} className="flex items-center justify-between gap-2">
                    <span className="font-mono">v{h.version} · {h.heldout ?? "?"}/{f.heldoutTotal}</span>
                    <span className={`rounded px-1.5 py-0.5 ${chip[h.status] ?? chip.superseded}`}>{h.status}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex flex-wrap gap-2">
                <button disabled={running} onClick={() => run(f.family)} className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">Run improvement round</button>
                <button disabled={running} onClick={() => run(f.family, { cheat: true })} className="rounded-md border border-zinc-300 px-2 py-1.5 text-xs disabled:opacity-40 dark:border-zinc-700" title="Scripted demo: a tool that memorises the visible answers">Try cheating tool</button>
                <button disabled={running} onClick={() => run(f.family, { simulateMissingUsage: true })} className="rounded-md border border-zinc-300 px-2 py-1.5 text-xs disabled:opacity-40 dark:border-zinc-700" title="Simulates a missing usage figure; the hold must stay and the round cannot succeed">Simulate missing usage</button>
              </div>
            </div>
          );
        })}
      </section>

      <section className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="mb-2 font-medium">Live timeline {running && <span className="ml-2 text-xs text-amber-600">running…</span>}</h2>
          <div ref={timeline} className="max-h-96 space-y-1.5 overflow-auto font-mono text-xs">
            {events.length === 0 && <p className="text-zinc-500">Run a round to see each step: reserve, sandbox, candidate, scores, gate, settle.</p>}
            {events.map((e, i) => (
              <div key={i} className={e.type === "gate" && !e.passed ? "text-rose-600" : e.type === "blocked_unsettled" || e.type === "error" || e.type === "refused" ? "text-rose-600" : e.type === "gate" ? "text-emerald-600" : ""}>• {describe(e)}</div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="mb-2 font-medium">Human review {proposals.length > 0 && <span className="ml-2 rounded bg-amber-100 px-1.5 text-xs text-amber-800">{proposals.length} waiting</span>}</h2>
          {proposals.length === 0 && <p className="text-xs text-zinc-500">Nothing is promoted until a person approves the exact code. Proposals that pass the gate appear here.</p>}
          {proposals.map((p) => (
            <div key={p.id} className="mb-3 rounded border border-zinc-200 p-3 text-xs dark:border-zinc-800">
              <div className="font-medium">{p.family} · v{p.version} · held-out {p.heldout} · feedback {p.visible}</div>
              <div className="mt-1 text-zinc-500">{p.rationale}</div>
              <div className="mt-1 font-mono text-[11px]">code sha256 {p.sha.slice(0, 16)}… (approval is bound to this hash)</div>
              <pre className="mt-2 max-h-48 overflow-auto rounded bg-zinc-50 p-2 text-[11px] dark:bg-zinc-900">{p.code}</pre>
              <div className="mt-2 flex gap-2">
                <button onClick={() => reviewTool(p.id, p.sha, "approve")} className="rounded bg-emerald-600 px-3 py-1 text-white">Approve and promote</button>
                <button onClick={() => reviewTool(p.id, p.sha, "reject")} className="rounded border border-zinc-300 px-3 py-1 dark:border-zinc-700">Reject</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="mb-2 font-medium">Ledger</h2>
        <table className="w-full text-xs">
          <thead className="text-left text-zinc-500"><tr><th className="py-1">Kind</th><th>Amount</th><th>Round</th><th>Idempotency key</th></tr></thead>
          <tbody className="font-mono">
            {state?.ledger.map((l) => (
              <tr key={l.id} className="border-t border-zinc-100 dark:border-zinc-800"><td className="py-1">{l.kind}</td><td>{usd(l.amount_micros)}</td><td>{l.round_id ?? "–"}</td><td className="max-w-[18rem] truncate">{l.idem_key ?? "–"}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <footer className="mt-6 text-xs text-zinc-500">Candidate code runs only in a CreateOS sandbox with outbound access blocked. Money is Stripe test mode. Veloce AgenticOS is prior work by the same author; this project is new for the hackathon.</footer>
    </main>
  );
}
