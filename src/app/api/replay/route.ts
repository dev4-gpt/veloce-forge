import { listRecordings } from "@/lib/replay";

// List recorded runs that can be replayed. Read-only and open, like /api/state: it only lists ids, status and counts.
export async function GET() {
  return Response.json({ recordings: await listRecordings(20) }, { headers: { "Cache-Control": "no-store" } });
}
