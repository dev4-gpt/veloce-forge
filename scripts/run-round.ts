// Local driver: run one improvement round against the real sandbox and Gemini.
// Usage: npx tsx --env-file=.env.local scripts/run-round.ts dates|money|durations
import { FAMILIES, type Family } from "../src/lib/bench/cases";
import { runRound } from "../src/lib/round";

const family = (process.argv[2] ?? "dates") as Family;
if (!FAMILIES[family]) {
  console.error("family must be one of: dates, money, durations");
  process.exit(1);
}

async function main() {
  console.log(`family=${family}`);
  const t0 = Date.now();
  const result = await runRound({
    family,
    currentCode: FAMILIES[family].baselineCode,
    emit: (e) => {
      const { type, code, cases, ...rest } = e as Record<string, unknown>;
      console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${type}`, JSON.stringify(rest).slice(0, 300));
      if (type === "candidate") console.log(String(code).split("\n").slice(0, 60).join("\n"));
      if (type === "visible_failures") console.log(JSON.stringify(cases).slice(0, 400));
    },
  });
  console.log("VERDICT:", result.verdict, "| visible", result.visible, "| heldout", result.heldout, "| attempts", result.attempts);
  console.log("USAGE:", JSON.stringify(result.usage));
  if (result.gate) console.log("GATE:", JSON.stringify(result.gate));
}

main().catch((e) => {
  console.error("round failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
