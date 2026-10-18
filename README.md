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

The proposer tries providers in order and falls back on rate limits or errors: **Gemini**, then **OpenRouter** and **NVIDIA NIM** (OpenAI-compatible). GitHub Models was removed after research found it retired on 2026-07-30. A provider is used only if both its key and model env vars are set; model ids are never hardcoded. Set `LLM_PROVIDERS` to change the order. Free tiers have rate limits, can change, and may use prompts for training, so use them only with synthetic data (as here), never with client data. Missing usage figures from any provider are treated as unknown, not zero. Tests: `npx tsx --test tests/llm.test.ts`.

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
node scripts/verify-report.mjs evidence.json --pubkey <base64 public key> --head <hash you saved last time>
```

It detects edited, removed or reordered entries, forged signatures (when you pin the key), approvals that do not match the code a round produced, and promotions whose own recorded numbers break the gate. It does **not** prove that the sandbox really ran or that the scores are true, and without a pinned key or a saved head hash it cannot catch someone who rewrites or truncates the whole chain. Rounds before this feature have no entries. If recording a report fails, the round still completes and the UI shows a warning.

## Replay of recorded runs

Each finished round's event stream is stored (`round_events`, immutable) and its digest is sealed into that round's chain entry. The timeline panel can replay any recorded run with its original pacing (long silences shortened) without a passcode, a sandbox, a model call or any money: replay is read-only code that cannot reach the wallet, and every replayed line is tagged `replay: true` and shown with a violet "replay" badge and a banner. The replay header says whether the stored events still match the sealed report. Limits: only rounds run after this feature existed are recorded (older rounds show as history cards only), and the seal shows the stream was not edited afterwards, not that the original live run was honest.

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
