// Shared demo passcode. A hackathon-grade control, NOT real authentication: it stops anonymous visitors from
// spending quota, approving proposals or claiming credits. Fails closed: if DEMO_PASSCODE is not configured,
// every protected route is refused.
import { createHash, timingSafeEqual } from "node:crypto";
import { countReviewers, findReviewerByToken, type Role } from "./db";

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

// ---- named identities with roles ----
export interface Identity {
  id: string; // "shared-passcode" in legacy demo mode
  name: string;
  role: Role | "shared";
}

/** Resolve who is calling.
 *  - If a reviewer token matches an active reviewer, that person is the identity.
 *  - If ANY reviewer exists, tokens are mandatory: the shared passcode is no longer accepted (no downgrade path).
 *  - Only while no reviewer exists does the shared passcode work (demo mode), as the pseudo identity "shared-passcode". */
export async function authenticate(req: Request, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: true; identity: Identity } | { ok: false; status: number; error: string }> {
  const token = req.headers.get("x-reviewer-token") ?? "";
  if (token) {
    const who = await findReviewerByToken(token);
    if (who) return { ok: true, identity: { id: who.id, name: who.name, role: who.role } };
  }
  if ((await countReviewers()) > 0) {
    return { ok: false, status: 401, error: token ? "unknown or disabled reviewer token" : "a reviewer token is required (x-reviewer-token)" };
  }
  const shared = checkPasscode(req, env);
  if (!shared.ok) return shared;
  return { ok: true, identity: { id: "shared-passcode", name: "shared demo passcode", role: "shared" } };
}

export async function requireRole(req: Request, roles: readonly (Role | "shared")[]): Promise<{ identity: Identity } | Response> {
  const a = await authenticate(req);
  if (!a.ok) return Response.json({ error: a.error }, { status: a.status });
  if (!roles.includes(a.identity.role)) {
    return Response.json({ error: `role "${a.identity.role}" is not allowed to do this` }, { status: 403 });
  }
  return { identity: a.identity };
}
