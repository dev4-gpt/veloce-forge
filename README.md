# Veloce Forge

**Self-improving agents that cannot promote themselves.**

Veloce Forge lets an AI agent write its own tools, proves them inside a CreateOS Sandbox, and refuses to adopt them unless they beat the current tool on **hidden held-out cases** and a **human approves the exact code hash**. Every round is metered against a Stripe-funded wallet.

Built for the **CreateOS × Stripe Projects** hackathon (Oct 17, 2026). Test mode only. All data is synthetic.

## Why

Agents that modify themselves are only useful in a business if the changes are bounded, budgeted, reviewed and traceable. Veloce Forge is a small, working version of that loop for an agency or operator who wants automations that improve without risking client data.

## How it works

1. **Reserve.** A round first reserves budget from the wallet. With no funds, it is refused and no sandbox is created.
2. **Evaluate.** The current tool runs in a CreateOS Sandbox (`devbox:1`, 1 vCPU) with outbound access restricted by an egress allowlist. A trusted runner prints only the tool's outputs; expected answers never enter the sandbox.
3. **Propose.** Gemini (`GEMINI_MODEL`, default `gemini-3.8-flash`) sees only the failing *feedback* cases (visible examples and user "field reports") and returns a new Python tool.
4. **Screen and score.** A static screen rejects forbidden imports and calls. The candidate runs in the sandbox on feedback cases and on **held-out cases it never sees**. The server scores the outputs.
5. **Gate.** Promotion requires a held-out gain of at least 2 cases, no regression on cases the current tool passed, and no drop on feedback cases.
6. **Human approval.** A passing candidate is only *proposed*. A person approves it, and the approval is bound to the SHA-256 of the exact code reviewed. Changing the code voids it.
7. **Settle.** Actual usage (model tokens, sandbox milliseconds) is settled and the remainder released. **Unknown usage is never treated as zero:** the hold stays and the round cannot succeed.

Benchmark: three synthetic "messy field" normalizers (dates to ISO, money to cents, durations to minutes), each with visible cases, field reports and 10 hidden held-out cases. The held-out set is committed by SHA-256 and shown in the UI.

## Guardrails shown in the demo

| # | Guarantee | Where |
|---|---|---|
| I1 | Authorisation and budget reservation come before any sandbox exists | `src/app/api/rounds/route.ts` |
| I2 | Missing usage is not zero (hold kept, round blocked) | "Simulate missing usage" button |
| I3 | A failed settlement cannot become a success | `src/lib/db.ts` `settle` |
| I4 | A stored candidate does not authorise use; approval is hash-bound | `src/lib/db.ts` `review` |
| I5 | Payments are idempotent; replaying a webhook is a no-op | "Replay webhook" button |
| I6 | Generated code runs only in the sandbox, with egress restricted | `src/lib/sandbox/client.ts` |
| - | The agent cannot game the gate: held-out answers stay on the server; a "cheating tool" that memorises visible answers is rejected | "Try cheating tool" button |

## Stripe Projects and CreateOS Sandbox

- **Stripe Projects** scaffolded and provisioned the stack (`stripe projects init`, then `add neon/postgres` and `add vercel/project`; see `.projects/state.json`). Stripe **Checkout in test mode** funds the wallet. The server refuses any non-test key, verifies payment with Stripe rather than trusting the browser, and credits at most once per session id. A signed webhook endpoint (`/api/webhook`) uses the same idempotency key.
- **CreateOS Sandbox** runs all untrusted, model-written code: create, upload, exec with stdin, egress allowlist, destroy. See `scripts/smoke-sandbox.mjs`.
- **Honest limits:** the API has no deny-all egress value (an empty list means allow-all), so a one-entry allowlist (`127.0.0.1`) is used to block outbound traffic; this was verified. **Sandbox fork was attempted but refused by the free plan's concurrency quota** (1 concurrent sandbox), so fork is not used in the demo. The wallet and tool library live in Neon Postgres, provisioned through Stripe Projects.

## Model providers (no single point of failure)

The proposer tries providers in order: **Gemini**, then Groq, OpenRouter, NVIDIA NIM, Mistral, Cerebras, SambaNova, Hugging Face and LLM7 (all but Gemini are OpenAI-compatible; their endpoints come from the free-LLM directories the author stars, which are third-party lists, so check each provider's own page for current limits and terms). A transient failure (429, 500/502/503/504, timeout, dropped connection) is first retried on the same provider after a short pause (`LLM_RETRY_DELAYS_MS`, default 1.5 s then 4 s; a 429 is retried once, a permanent error such as 401 is not retried), and only then does the next provider take over. A timeout is never retried, each provider call is capped at 45 s (`LLM_CALL_TIMEOUT_MS`) so a hung provider cannot starve the fallbacks, and one model call has a total time budget (`LLM_TOTAL_BUDGET_MS`, default 100 s) across providers and retries so a round always finishes inside Vercel's 300 s function limit (found in a live run, where a round that overran was killed and left its money held with no report). A provider that rejects JSON mode gets one retry without it. A provider is used only if both its key and model env vars are set; model ids are never hardcoded. Set `LLM_PROVIDERS` to change the order. GitHub Models was removed after research found it retired on 2026-07-30. Free tiers have rate limits, can change, and may use prompts for training, so use them only with synthetic data (as here), never with client data. Missing usage figures from any provider are treated as unknown, not zero. Tests: `npx tsx --test tests/llm.test.ts`.

## Run it

```bash
npm install
# keys (never commit): CREATEOS_SANDBOX_API_KEY, GEMINI_API_KEY, GEMINI_MODEL,
# NEON_POSTGRES_CONNECTION_STRING (from stripe projects env --pull), STRIPE_SECRET_KEY (sk_test_...)
cp .env.example .env.local   # then fill in
npm run dev
npx tsx --test tests/gate.test.ts        # unit tests for the gate, scoring and screen
npx tsx --env-file=.env.local scripts/run-round.ts dates   # one real round from the CLI
node --env-file=.env.local scripts/smoke-sandbox.mjs       # sandbox smoke test
```

## Tamper-evident round reports

Every round and every approval is appended to a hash chain (`report_chain`): each entry's hash covers its content and the previous hash, and can be Ed25519-signed (`REPORT_SIGNING_KEY`). Export it from `/api/evidence` (needs the passcode or a reviewer token) and check it offline, with a script that imports nothing from this repo:

```bash
node scripts/verify-report.mjs evidence.json --pubkey <base64 public key> --signed-from <first signed entry> --head <hash you saved last time>
```

It detects edited, removed or reordered entries, forged signatures (when you pin the key), approvals that do not match the code a round produced, and promotions whose own recorded numbers break the gate. It does **not** prove that the sandbox really ran or that the scores are true, and without a pinned key or a saved head hash it cannot catch someone who rewrites or truncates the whole chain. `--signed-from N` pins the key only from entry N on, for a chain whose first entries predate the signing key; a signed entry authenticates everything before it, because every hash covers the previous one, and the check fails if no entry exists at or after N. Rounds before this feature have no entries. If recording a report fails, the round still completes and the UI shows a warning.

## Replay of recorded runs

Each finished round's event stream is stored (`round_events`, immutable) and its digest is sealed into that round's chain entry. The timeline panel can replay any recorded run with its original pacing (long silences shortened) without a passcode, a sandbox, a model call or any money: replay is read-only code that cannot reach the wallet, and every replayed line is tagged `replay: true` and shown with a violet "replay" badge and a banner. The replay header says whether the stored events still match the sealed report. Limits: only rounds run after this feature existed are recorded (older rounds show as history cards only), and the seal shows the stream was not edited afterwards, not that the original live run was honest.

## Paying for a round with a Stripe card hold (test mode)

Besides the credit wallet, a round can be paid with a Stripe manual-capture card hold (checkbox in the UI, or `payWith: "card_hold"` in `POST /api/rounds`): a 50¢ authorisation is placed before any sandbox exists, the round runs, then the hold is captured or released. Test mode only: `STRIPE_SECRET_KEY` must be `sk_test_`/`rk_test_` and live-mode objects are refused. Every state change is a compare-and-set with Stripe idempotency keys, so a retry cannot capture twice; a capture or release whose response is lost is `pending` and `POST /api/holds {action:"reconcile"}` finishes it from what Stripe says.

What was verified against real Stripe test mode (`scripts/stripe-hold-smoke.ts`): the 50¢ authorisation, cancel, idempotent create, a refused second capture, and that **Stripe refuses any capture under $0.50**. So a card round cannot bill its exact few-cent cost: a finished round is charged the 50¢ minimum (use the wallet for exact metering). With `CARD_CAPTURE_POLICY=on_green` only a round that produces a gate-passing proposal is charged and every other completed round is released. A round that fails before any sandbox ran is released. If usage is unknown, nothing is captured or released: the hold is parked as `unresolved` for a person (`release_unresolved`), and reconcile never decides that by itself. Not covered: saving a customer's own card (it uses Stripe's published test card `pm_card_visa`), Stripe webhooks for holds, and any live-mode use.

## Fresh audit after promotion

A held-out set is used to choose between candidates, so the score of the winner is biased upward. Each family can also have a **frozen audit set** (`audit:<family>`, private, never shown to the proposer, never part of any promotion decision). After a person approves a tool, the server scores it once on that set, in a sandbox with outbound access proven blocked, against the version it replaced. The audit fails if the audit score dropped, if any case the old version passed now fails, or if the held-out rate is more than 3/10 above the audit rate (the signature of selecting for the held-out set). The result is stored (`audits`, immutable), sealed into the hash chain (the offline verifier re-checks the numbers), and shown on the family card as `audit passed` or `AUDIT FAILED`. A failed audit does not undo anything by itself: a reviewer can **revoke** the tool, which brings back the version it replaced in a single statement (never leaving the family without an active tool). If no audit set is configured, the wallet is empty or the sandbox fails, the tool is reported as unaudited (the failure to audit is visible, and it is not counted as a failed audit).

Seed the sets with `npx tsx --env-file=.env --env-file=.env.local scripts/seed-heldout.ts` (reads `private/heldout.json` and `private/audit.json`, refuses an audit input that also appears in the held-out set). Limits: every audit still reveals a little about the set to whoever reads the results, so refresh the set from time to time (a new set has a new commitment and is audited separately); ten cases per family is a small sample, so the 3/10 gap rule is deliberately loose; the audit costs a sandbox run and one of the daily free-plan sandboxes.

## Operating notes (found in live use)

- **Killed rounds.** A round the platform kills (Vercel's 300 s limit) never reaches its cleanup, so it can leave a wallet hold and a running sandbox. A leaked sandbox of ours (named `vf-xxx-<time>`, older than six minutes) is destroyed automatically when the one-sandbox quota blocks a new round; a recent or foreign sandbox is never touched. Stuck wallet holds are listed at `GET /api/wallet/holds` and given back by a person with `POST /api/wallet/holds {"round":"r-..."}` or `{"all":true}` (recorded in the ledger as `operator_release:<round>`; the amount is the one actually reserved, and a running or already settled round is refused).
- **Rounds from before the chain.** `scripts/declare-legacy.ts <tool id>` appends an `epoch` entry saying a tool's round happened before the report chain existed, so the offline verifier accepts a decision on it that has no round entry. It excuses only the tools it names, and a tool that also has a round entry in the chain is flagged.

## Prior work and attribution

The author's earlier project, **Veloce AgenticOS** (a governed AI workspace), is prior work and inspired the invariants above (budget reservation and settlement, hash-bound approval). **No Veloce code was copied into this repository; everything here was written during the hackathon.** This project is not affiliated with CreateOS, Stripe or Google. Third-party: CreateOS Sandbox REST API, Stripe (test mode), Neon, Vercel, Gemini API, Next.js, `@neondatabase/serverless`, `stripe`, `tsx`.

## Limitations

- **Demo access control:** viewing is open, but running rounds, approving tools, claiming demo credits and replaying the webhook need a shared demo passcode (`DEMO_PASSCODE`, fails closed if unset). This is a hackathon-grade shared secret, not real authentication, and there is no reviewer identity.
- **The held-out cases are public:** they live in `src/lib/bench/cases.ts`, so the held-out score is demo-grade, not evidence of generalisation. A real deployment would keep them private and rotate them.
- Test coverage is limited to the gate, provider fallback and passcode check (mocked network). The database layer, routes, Stripe paths and sandbox client were exercised live but have no automated tests.

- Small synthetic benchmark; not evidence of general self-improvement.
- Demo cost rates are made-up constants, not real pricing.
- Single demo tenant; no real authentication.
- Not production-ready; not security-audited. The sandbox is the real boundary; the static screen is defence in depth.
