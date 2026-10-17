// Shared demo passcode. A hackathon-grade control, NOT real authentication: it stops anonymous visitors from
// spending quota, approving proposals or claiming credits. Fails closed: if DEMO_PASSCODE is not configured,
// every protected route is refused.
import { createHash, timingSafeEqual } from "node:crypto";

const digest = (s: string) => createHash("sha256").update(s).digest();

export function checkPasscode(req: Request, env: NodeJS.ProcessEnv = process.env): { ok: true } | { ok: false; status: number; error: string } {
  const expected = env.DEMO_PASSCODE;
  if (!expected) return { ok: false, status: 503, error: "demo passcode is not configured on the server" };
  const given = req.headers.get("x-demo-passcode") ?? "";
  if (!given) return { ok: false, status: 401, error: "demo passcode required (enter it in the page header)" };
  const same = timingSafeEqual(digest(given), digest(expected));
  return same ? { ok: true } : { ok: false, status: 401, error: "wrong demo passcode" };
}

/** Use at the top of a route handler: `const denied = requirePasscode(req); if (denied) return denied;` */
export function requirePasscode(req: Request): Response | null {
  const r = checkPasscode(req);
  return r.ok ? null : Response.json({ error: r.error }, { status: r.status });
}
