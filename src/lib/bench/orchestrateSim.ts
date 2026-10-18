// Orchestrate pillar: a deterministic, server-side simulator that SCORES a plan. The model-written tool only returns a plan;
// it never sees the optimum, and the optimum never enters the sandbox. Everything here is pure and testable.
export const PILLARS = ["command", "context", "create", "govern", "deliver"] as const;

export interface Task {
  id: string;
  pillar: string;
  cost: number;
  value: number;
  time: number;
  deps: string[];
}
export interface Job {
  budget: number;
  handoff: number; // extra cost for a multi-agent task that has a dependency run by a different pillar agent
  tasks: Task[];
}
export type Mode = "single" | "multi";
export interface Plan {
  mode: Mode;
  steps: string[];
}

/** A generalist (single) agent costs 1.4x per task, rounded up (integer arithmetic only). */
export const singleCost = (cost: number) => Math.floor((cost * 14 + 9) / 10);
/** A cross-pillar handoff adds this much waiting time before the receiving task can start. */
export const HANDOFF_TIME = 1;
export const MAX_TASKS = 8;

export type Verdict = { valid: true; net2: number; cost: number; makespan: number } | { valid: false; reason: string };

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Strict job parser: returns null for anything malformed (also used to protect the scorer from hostile input). */
export function parseJob(raw: string): Job | null {
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || !isInt(j.budget) || !isInt(j.handoff) || !Array.isArray(j.tasks) || j.tasks.length === 0 || j.tasks.length > MAX_TASKS) return null;
  const ids = new Set<string>();
  for (const t of j.tasks) {
    if (!t || typeof t.id !== "string" || typeof t.pillar !== "string" || !isInt(t.cost) || !isInt(t.value) || !isInt(t.time) || !Array.isArray(t.deps)) return null;
    if (t.cost < 0 || t.value < 0 || t.time < 1 || ids.has(t.id)) return null;
    ids.add(t.id);
  }
  for (const t of j.tasks) for (const d of t.deps) if (typeof d !== "string" || !ids.has(d) || d === t.id) return null;
  return j as Job;
}

/** Run an already-validated ordered list of task ids. net2 is DOUBLED so the 0.5 time penalty stays an integer. */
function simulate(job: Job, order: string[], mode: Mode): { cost: number; makespan: number; value: number } {
  const byId = new Map(job.tasks.map((t) => [t.id, t]));
  const finish = new Map<string, number>();
  const agentFree = new Map<string, number>();
  let cost = 0;
  let value = 0;
  let makespan = 0;
  let clock = 0;
  for (const id of order) {
    const t = byId.get(id)!;
    value += t.value;
    if (mode === "single") {
      cost += singleCost(t.cost);
      clock += t.time;
      finish.set(id, clock);
      makespan = clock;
    } else {
      let ready = 0;
      let crossed = false;
      for (const d of t.deps) {
        const dep = byId.get(d)!;
        const cross = dep.pillar !== t.pillar;
        crossed ||= cross;
        ready = Math.max(ready, finish.get(d)! + (cross ? HANDOFF_TIME : 0));
      }
      const start = Math.max(agentFree.get(t.pillar) ?? 0, ready);
      const end = start + t.time;
      agentFree.set(t.pillar, end);
      finish.set(id, end);
      makespan = Math.max(makespan, end);
      cost += t.cost + (crossed ? job.handoff : 0);
    }
  }
  return { cost, makespan, value };
}

/** Validate a plan strictly, then score it. Anything unexpected is INVALID (score 0): unknown keys, unknown ids, duplicates
 *  (would double-count value), missing or late dependencies, over budget. */
export function evaluate(job: Job, plan: unknown): Verdict {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return { valid: false, reason: "plan must be a JSON object" };
  const keys = Object.keys(plan).sort().join(",");
  if (keys !== "mode,steps") return { valid: false, reason: "plan must have exactly the keys mode and steps" };
  const { mode, steps } = plan as { mode: unknown; steps: unknown };
  if (mode !== "single" && mode !== "multi") return { valid: false, reason: "mode must be single or multi" };
  if (!Array.isArray(steps) || steps.some((s) => typeof s !== "string") || steps.length > job.tasks.length) return { valid: false, reason: "steps must be a list of task ids" };
  const byId = new Map(job.tasks.map((t) => [t.id, t]));
  const pos = new Map<string, number>();
  for (let i = 0; i < steps.length; i++) {
    const id = steps[i] as string;
    if (!byId.has(id)) return { valid: false, reason: `unknown task ${id}` };
    if (pos.has(id)) return { valid: false, reason: `task ${id} appears twice` };
    pos.set(id, i);
  }
  for (const id of steps as string[]) {
    for (const d of byId.get(id)!.deps) {
      if (!pos.has(d)) return { valid: false, reason: `task ${id} is missing its dependency ${d}` };
      if (pos.get(d)! > pos.get(id)!) return { valid: false, reason: `task ${id} runs before its dependency ${d}` };
    }
  }
  const r = simulate(job, steps as string[], mode);
  if (r.cost > job.budget) return { valid: false, reason: `cost ${r.cost} exceeds budget ${job.budget}` };
  return { valid: true, net2: 2 * r.value - r.makespan, cost: r.cost, makespan: r.makespan };
}

/** Brute-force optimum over every dependency-closed subset, every topological order and both modes (n <= 8, practical <= 6). */
export function solve(job: Job): { optimum2: number; single2: number } {
  const n = job.tasks.length;
  const idx = job.tasks.map((t) => t.id);
  const depMask = job.tasks.map((t) => t.deps.reduce((m, d) => m | (1 << idx.indexOf(d)), 0));
  let optimum2 = 0; // the empty plan is always valid and scores 0
  let single2 = 0;
  const orders = (subset: number, done: number, cur: string[], visit: (o: string[]) => void) => {
    if (done === subset) return visit(cur);
    for (let i = 0; i < n; i++) {
      const bit = 1 << i;
      if (subset & bit && !(done & bit) && (depMask[i] & done) === depMask[i]) {
        cur.push(idx[i]);
        orders(subset, done | bit, cur, visit);
        cur.pop();
      }
    }
  };
  for (let subset = 1; subset < 1 << n; subset++) {
    let closed = true;
    for (let i = 0; i < n && closed; i++) if (subset & (1 << i) && (depMask[i] & subset) !== depMask[i]) closed = false;
    if (!closed) continue;
    orders(subset, 0, [], (o) => {
      for (const mode of ["single", "multi"] as const) {
        const r = simulate(job, o, mode);
        if (r.cost > job.budget) continue;
        const net2 = 2 * r.value - r.makespan;
        if (net2 > optimum2) optimum2 = net2;
        if (mode === "single" && net2 > single2) single2 = net2;
      }
    });
  }
  return { optimum2, single2 };
}

/** The pass rule: valid, at least as good as the best single-agent plan, and within 10% of the true optimum. */
export function scoreOrchestrate(c: { input: string; expected: string | number }, got: unknown): boolean {
  if (typeof got !== "string") return false;
  const job = parseJob(c.input);
  if (!job) return false;
  let exp: { optimum2: number; single2: number };
  let plan: unknown;
  try {
    exp = JSON.parse(String(c.expected));
    plan = JSON.parse(got);
  } catch {
    return false;
  }
  const v = evaluate(job, plan);
  if (!v.valid) return false;
  return v.net2 >= exp.single2 && v.net2 * 10 >= 9 * exp.optimum2 && v.net2 >= 0;
}

// ---- seeded scenario generator (the generator is public; the seeds of the sealed set are not) ----
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateJob(seed: number): Job {
  const r = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const n = int(4, 6);
  const tasks: Task[] = [];
  for (let i = 0; i < n; i++) {
    const deps: string[] = [];
    for (let j = 0; j < i; j++) if (deps.length < 2 && r() < 0.45) deps.push(`T${j + 1}`);
    tasks.push({ id: `T${i + 1}`, pillar: PILLARS[int(0, PILLARS.length - 1)], cost: int(4, 24), value: int(3, 30), time: int(1, 5), deps });
  }
  const sum = tasks.reduce((s, t) => s + t.cost, 0);
  return { budget: Math.max(Math.min(...tasks.map((t) => singleCost(t.cost))), Math.floor(sum * (0.5 + r() * 0.6))), handoff: int(2, 6), tasks };
}

export function makeCase(seed: number): { input: string; expected: string } {
  const job = generateJob(seed);
  return { input: JSON.stringify(job), expected: JSON.stringify(solve(job)) };
}
