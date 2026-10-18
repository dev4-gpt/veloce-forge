import { FAMILIES, FAMILY_LIST, PARTNER } from "@/lib/bench/cases";
import { chainHead } from "@/lib/chainStore";
import { ensureSchema, getActive, getHeldoutSet, getWallet, listTools, recentLedger } from "@/lib/db";


export async function GET() {
  await ensureSchema();
  const [wallet, ledger] = await Promise.all([getWallet(), recentLedger(15)]);
  const families = await Promise.all(
    FAMILY_LIST.map(async (f) => {
      const active = await getActive(f);
      const tools = await listTools(f);
      const held = await getHeldoutSet(f);
      const sealed = PARTNER[f] ? await getHeldoutSet("e2e") : null;
      return {
        family: f,
        title: FAMILIES[f].title,
        pillar: FAMILIES[f].pillar,
        heldoutTotal: held ? held.cases.length : 0,
        feedbackTotal: FAMILIES[f].visible.length + FAMILIES[f].field.length,
        heldoutCommitment: held ? held.sha : null,
        crossCheck: PARTNER[f] ? { partner: PARTNER[f], total: sealed ? sealed.cases.length : 0, commitment: sealed ? sealed.sha : null } : null,
        activeId: active.id,
        activeVersion: active.version,
        activeHeldout: active.heldout_count,
        history: tools.map((t) => ({
          id: t.id,
          version: t.version,
          status: t.status,
          heldout: t.heldout_count,
          visible: t.visible_count,
          sha: t.sha,
          rationale: t.rationale,
          gate: t.gate,
          code: t.status === "proposed" ? t.code : undefined,
          createdAt: t.created_at,
        })),
      };
    }),
  );
  return Response.json({ wallet, families, ledger, reportHead: await chainHead() });
}
