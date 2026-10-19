// Per-family scoring hooks. Families without an entry use exact-match scoring. A custom scorer runs on the SERVER
// (never in the sandbox), so the hidden optimum or answer never reaches model-written code.
import type { Family } from "./cases";
import { scoreOrchestrate } from "./orchestrateSim";

export type Scorer = (c: { input: string; expected: string | number }, got: unknown) => boolean;
export const SCORERS: Partial<Record<Family, Scorer>> = {
  orchestrate: scoreOrchestrate,
};
