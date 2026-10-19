import { readChain } from "@/lib/chainStore";
import { loadSigner } from "@/lib/evidence";
import { requireRole } from "@/lib/auth";

// Export the whole report chain as one JSON file for offline checking: node scripts/verify-report.mjs evidence.json
// Reports contain candidate code and gate reasons, so this needs a role like the other operator routes.
export async function GET(req: Request) {
  const auth = await requireRole(req, ["operator", "reviewer", "admin", "shared"]);
  if (auth instanceof Response) return auth;
  const entries = await readChain();
  const signer = loadSigner();
  return Response.json(
    {
      format: "veloce-forge/report-chain/v1",
      exportedAt: new Date().toISOString(),
      publicKey: signer ? signer.publicKeyB64 : null, // embedded for convenience; pin it yourself with --pubkey to mean anything
      head: entries.length ? entries[entries.length - 1].hash : null,
      entries,
    },
    { headers: { "Cache-Control": "no-store", "Content-Disposition": 'attachment; filename="veloce-forge-evidence.json"' } },
  );
}
