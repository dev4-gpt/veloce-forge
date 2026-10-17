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

## Prior work and attribution

The author's earlier project, **Veloce AgenticOS** (a governed AI workspace), is prior work and inspired the invariants above (budget reservation and settlement, hash-bound approval). **No Veloce code was copied into this repository; everything here was written during the hackathon.** This project is not affiliated with CreateOS, Stripe or Google. Third-party: CreateOS Sandbox REST API, Stripe (test mode), Neon, Vercel, Gemini API, Next.js, `@neondatabase/serverless`, `stripe`, `tsx`.

## Limitations

- Small synthetic benchmark; not evidence of general self-improvement.
- Demo cost rates are made-up constants, not real pricing.
- Single demo tenant; no real authentication.
- Not production-ready; not security-audited. The sandbox is the real boundary; the static screen is defence in depth.
