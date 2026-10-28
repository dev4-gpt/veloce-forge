import { connection } from "next/server";
import { listRecordings } from "@/lib/replay";

// List recorded runs that can be replayed. Read-only and open, like /api/state: it only lists ids, status and counts.
export async function GET() {
  // Read the database per request, never while building: a build or preview without a database must still succeed.
  await connection();
  return Response.json({ recordings: await listRecordings(20) }, { headers: { "Cache-Control": "no-store" } });
}
