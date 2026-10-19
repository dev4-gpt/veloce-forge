import { readChain } from "@/lib/chainStore";
import { checkIntegrity, loadRecording, planReplay } from "@/lib/replay";

export const maxDuration = 120;

// Play back a recorded round as NDJSON, every line tagged replay:true. Read-only: no sandbox, no model call, no wallet access.
// The recorded events are the ones the original operator already saw (candidate code, scores, gate verdict), and /api/state
// already exposes the same facts, so this is open like /api/state. Query: ?speed=0.5..8 (default 1).
export async function GET(req: Request, ctx: { params: Promise<{ round: string }> }) {
  const { round } = await ctx.params;
  const rec = await loadRecording(round);
  if (!rec) return Response.json({ error: "no recording for that round (only rounds run after replay was added are recorded)" }, { status: 404 });
  const speed = Number(new URL(req.url).searchParams.get("speed") ?? "1");
  const steps = planReplay(rec, checkIntegrity(rec, await readChain()), { speed });

  const enc = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      for (const s of steps) {
        if (s.delayMs > 0) await new Promise((r) => setTimeout(r, s.delayMs));
        if (cancelled) return;
        controller.enqueue(enc.encode(JSON.stringify(s.line) + "\n"));
      }
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Replay": "true" } });
}
