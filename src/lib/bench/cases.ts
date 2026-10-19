// Synthetic benchmark: three "messy field" normalizers. Visible and field cases are shown to the agent
// (input, expected, got) when it fails them. The HELD-OUT cases are NOT in this repository: they live in the
// database (seeded from the git-ignored private/heldout.json). Only their raw inputs go to the sandbox;
// expected values stay on the server and are used only by the gate.
import { createHash } from "node:crypto";
import { ORCH_FIELD, ORCH_VISIBLE } from "./orchestrateData";

export type Pillar = "command" | "context" | "orchestrate" | "create" | "govern" | "deliver";
export type Family = "dates" | "money" | "durations" | "command" | "context" | "govern" | "orchestrate";
export type Case = { input: string; expected: string | number };

export interface FamilySpec {
  family: Family;
  pillar: Pillar; // which pillar of the workspace this agent belongs to
  agentRole: string; // role line given to the model: each pillar agent has its own job
  extraImports?: string[]; // per-pillar additions to the static-screen import allowlist
  title: string;
  instruction: string;
  visible: Case[];
  field: Case[]; // "field reports": user-flagged failures; shown to the agent in later rounds; disjoint from held-out
  baselineCode: string; // library v0: deliberately naive
}

const dates: FamilySpec = {
  family: "dates",
  pillar: "create",
  agentRole: "You are the Create-pillar agent: you build small, reusable data-normalising tools.",
  title: "Dates to ISO",
  instruction:
    "normalize(raw: str) -> str. Return the date as ISO 'YYYY-MM-DD'. Rules: slash dates are US month/day/year; " +
    "two-digit years mean 20YY; month names may be full or 3-letter English, may have an ordinal suffix (1st, 5th), " +
    "and the text may start with a weekday name. Raise ValueError for anything that is not a valid date.",
  visible: [
    { input: "2026-10-05", expected: "2026-10-05" },
    { input: "Oct 5, 2026", expected: "2026-10-05" },
    { input: "5 October 2026", expected: "2026-10-05" },
    { input: "10/05/2026", expected: "2026-10-05" },
    { input: "March 3, 2025", expected: "2025-03-03" },
    { input: "12/31/2024", expected: "2024-12-31" },
  ],
  field: [
    { input: "2025.03.01", expected: "2025-03-01" },
    { input: "07-Jan-25", expected: "2025-01-07" },
    { input: "2025/12/25", expected: "2025-12-25" },
    { input: "Tuesday, March 3, 2026", expected: "2026-03-03" },
    { input: "Sep 9th 2025", expected: "2025-09-09" },
    { input: "6/7/25", expected: "2025-06-07" },
  ],
  baselineCode: `def normalize(raw):
    s = raw.strip()
    parts = s.split("-")
    if len(parts) == 3 and len(parts[0]) == 4 and parts[1].isdigit() and parts[2].isdigit():
        return s
    raise ValueError("unsupported date format")
`,
};

const money: FamilySpec = {
  family: "money",
  pillar: "create",
  agentRole: "You are the Create-pillar agent: you build small, reusable data-normalising tools.",
  title: "Money to integer cents",
  instruction:
    "normalize(raw: str) -> int. Return the amount in integer cents. Rules: currency symbols or codes (dollar, euro, pound signs, USD, EUR, GBP) " +
    "may be a prefix or suffix; thousands separators may be comma, dot or space; the decimal separator may be dot or comma. " +
    "If both comma and dot appear, the LAST one is the decimal separator. If only one separator type appears and exactly " +
    "1 or 2 digits follow it, it is the decimal separator; if exactly 3 digits follow it, it is a thousands separator. " +
    "A leading '-' or surrounding parentheses mean negative. A trailing cent sign means the number is already cents. " +
    "Raise ValueError if no amount can be parsed.",
  visible: [
    { input: "$1,234.50", expected: 123450 },
    { input: "USD 12", expected: 1200 },
    { input: "$0.99", expected: 99 },
    { input: "12.5", expected: 1250 },
    { input: "-$3.20", expected: -320 },
    { input: "99¢", expected: 99 },
  ],
  field: [
    { input: "€ 12,50", expected: 1250 },
    { input: "12,50 EUR", expected: 1250 },
    { input: "$ 2 500.00", expected: 250000 },
    { input: "(3.99)", expected: -399 },
    { input: "2.000,00 £", expected: 200000 },
    { input: "1,000", expected: 100000 },
  ],
  baselineCode: `def normalize(raw):
    s = raw.replace("$", "").replace(",", "").strip()
    return int(round(float(s) * 100))
`,
};

const durations: FamilySpec = {
  family: "durations",
  pillar: "create",
  agentRole: "You are the Create-pillar agent: you build small, reusable data-normalising tools.",
  title: "Durations to minutes",
  instruction:
    "normalize(raw: str) -> int. Return the duration in whole minutes (round half up). Rules: formats include '1h30m', " +
    "'90 min', '2 hours', '1 hr 15 min', decimal hours like '1.5 hrs', clock style 'H:MM' and 'H:MM:SS', ISO 'PT1H30M', " +
    "seconds like '3600 s', days like '1 day' (= 1440 minutes). A bare number with no unit means minutes. " +
    "Raise ValueError if nothing can be parsed.",
  visible: [
    { input: "1h30m", expected: 90 },
    { input: "90 min", expected: 90 },
    { input: "2 hours", expected: 120 },
    { input: "45m", expected: 45 },
    { input: "1 hr 15 min", expected: 75 },
    { input: "3h", expected: 180 },
  ],
  field: [
    { input: "2.5 hrs", expected: 150 },
    { input: "0:45", expected: 45 },
    { input: "PT45M", expected: 45 },
    { input: "7200 s", expected: 120 },
    { input: "3h 10m", expected: 190 },
    { input: "2 days", expected: 2880 },
  ],
  baselineCode: `def normalize(raw):
    s = raw.strip().lower()
    if s.endswith("m") and s[:-1].isdigit():
        return int(s[:-1])
    raise ValueError("unsupported duration format")
`,
};

const command: FamilySpec = {
  family: "command",
  pillar: "command",
  agentRole: "You are the Command-pillar agent: you route what a person types to exactly one intent, and you must send anything legal, angry or human-requested to escalation.",
  title: "Command: intent routing",
  instruction:
    "normalize(raw: str) -> str. Route one user command to a business assistant to exactly one label: 'escalate', 'refund', 'cancel', 'report', 'status' or 'unknown'. " +
    "Lowercase the text and split it into words (letters and apostrophes only). Apply these rules IN ORDER and return the label of the first rule that matches: " +
    "(1) escalate if any word is one of: lawyer, lawyers, attorney, sue, suing, lawsuit, legal, chargeback, chargebacks, regulator, manager, supervisor, human. " +
    "(2) refund if any word starts with 'refund' or 'reimburs', or the text contains 'money back'. " +
    "(3) cancel if any word starts with 'cancel' or is 'terminate' or 'unsubscribe', or the text contains 'stop my'. " +
    "(4) report if any word is one of: report, reports, export, analytics, or starts with 'summar'. " +
    "(5) status if any word is one of: status, track, tracking, progress, or the text contains 'where is' or \"where's\". " +
    "(6) otherwise unknown. Never raise an error.",
  visible: [
    { input: "I want a refund for my last order", expected: "refund" },
    { input: "Please cancel my subscription", expected: "cancel" },
    { input: "Where is my order #1234?", expected: "status" },
    { input: "Send me the weekly sales report", expected: "report" },
    { input: "I will contact my lawyer about this", expected: "escalate" },
    { input: "What's the weather like?", expected: "unknown" },
  ],
  field: [
    { input: "Can I get my money back?", expected: "refund" },
    { input: "Unsubscribe me from the plan", expected: "cancel" },
    { input: "Tracking info for package please", expected: "status" },
    { input: "Export the analytics for March", expected: "report" },
    { input: "Put me through to a manager", expected: "escalate" },
    { input: "asdf qwerty", expected: "unknown" },
  ],
  baselineCode: `def normalize(raw):
    s = raw.lower()
    if "refund" in s:
        return "refund"
    if "cancel" in s:
        return "cancel"
    return "unknown"
`,
};

const context: FamilySpec = {
  family: "context",
  pillar: "context",
  agentRole: "You are the Context-pillar agent: you decide which knowledge-base document answers a question, and you say 'none' when nothing fits instead of guessing.",
  title: "Context: retrieval",
  instruction:
    "normalize(raw: str) -> str. Return the id of the single best knowledge-base document for a question, or 'none'. " +
    "Documents and their keywords: " +
    "refund-policy: refund, refunds, return, returns, money, back, days | " +
    "shipping: shipping, ship, delivery, deliver, courier, tracking, days | " +
    "pricing: price, prices, pricing, cost, plan, plans, fee, subscription | " +
    "security: password, security, 2fa, login, breach, encryption | " +
    "api: api, key, keys, token, endpoint, rate, limit | " +
    "onboarding: onboarding, start, setup, getting, started, welcome, invite | " +
    "billing: invoice, invoices, billing, payment, card, charged | " +
    "support: support, help, contact, hours, phone, email. " +
    "Lowercase the question and split it into words made of letters and digits. A question word matches a keyword if they are equal, or if the keyword has at least 4 letters and the word starts with it (so 'invoices' matches 'invoice'). " +
    "A document's score is the number of its DISTINCT keywords matched by at least one question word. Return the document with the highest score; break ties by the alphabetically smaller id; return 'none' if every score is 0.",
  visible: [
    { input: "How many days do I have to return an item?", expected: "refund-policy" },
    { input: "What does the pro plan cost?", expected: "pricing" },
    { input: "I forgot my password", expected: "security" },
    { input: "Where can I find my API key?", expected: "api" },
    { input: "My card was charged twice", expected: "billing" },
    { input: "What is your phone number?", expected: "support" },
  ],
  field: [
    { input: "Does your courier deliver on weekends?", expected: "shipping" },
    { input: "Need help inviting my team", expected: "support" },
    { input: "Enable 2fa on my login", expected: "security" },
    { input: "Download last month's invoices", expected: "billing" },
    { input: "What is the rate limit for the endpoint?", expected: "api" },
    { input: "Tell me about the weather", expected: "none" },
  ],
  baselineCode: `def normalize(raw):
    q = raw.lower()
    if "refund" in q or "return" in q:
        return "refund-policy"
    if "price" in q or "cost" in q:
        return "pricing"
    return "none"
`,
};

const govern: FamilySpec = {
  family: "govern",
  pillar: "govern",
  agentRole: "You are the Govern-pillar agent: you review an AI agent's action log line and decide allow, flag or block strictly by the written policy, never by intuition.",
  title: "Govern: action policy",
  instruction:
    "normalize(raw: str) -> str. Decide whether an AI agent action log line is 'allow', 'flag' or 'block'. " +
    "The line is space-separated; tokens of the form key=value give fields (ignore tokens without '='). Apply these rules IN ORDER; the first match wins: " +
    "(1) block if action is one of: delete_database, disable_audit, export_all_customers. " +
    "(2) block if action is one of: send_email, post_social, charge_card AND approved is not exactly 'yes' (a missing approved field counts as not approved). " +
    "(3) flag if amount is present and is greater than 500. " +
    "(4) flag if recipients is present and is greater than 100. " +
    "(5) flag if the lowercased line contains the substring 'password' or contains the whole word 'ssn'. " +
    "(6) otherwise allow. Numbers are integers; if a number field is missing or not an integer, treat that rule as not matching.",
  visible: [
    { input: "agent=support action=send_email recipients=1 approved=yes", expected: "allow" },
    { input: "agent=finance action=charge_card amount=900 approved=yes", expected: "flag" },
    { input: "agent=ops action=disable_audit approved=yes", expected: "block" },
    { input: "agent=outreach action=send_email recipients=250 approved=yes", expected: "flag" },
    { input: "agent=social action=post_social approved=no", expected: "block" },
    { input: "agent=support action=lookup note=customer ssn 123", expected: "flag" },
  ],
  field: [
    { input: "agent=ops action=delete_database approved=yes", expected: "block" },
    { input: "agent=finance action=charge_card amount=40 approved=no", expected: "block" },
    { input: "agent=outreach action=send_email recipients=100 approved=yes", expected: "allow" },
    { input: "agent=support action=lookup note=PASSWORD reset", expected: "flag" },
    { input: "agent=growth action=export_all_customers approved=yes", expected: "block" },
    { input: "agent=support action=send_email approved=yes recipients=3", expected: "allow" },
  ],
  baselineCode: `def normalize(raw):
    if "action=disable_audit" in raw:
        return "block"
    return "allow"
`,
};

const orchestrate: FamilySpec = {
  family: "orchestrate",
  pillar: "orchestrate",
  agentRole: "You are the Orchestrate-pillar agent: you plan how a job is executed, and choosing a single generalist agent instead of a team is a perfectly good plan when coordination costs more than it saves.",
  title: "Orchestrate: execution plan",
  extraImports: ["json"],
  instruction:
    "normalize(raw: str) -> str. raw is a JSON job: {\"budget\": int, \"handoff\": int, \"tasks\": [{\"id\": str, \"pillar\": str, \"cost\": int, \"value\": int, \"time\": int, \"deps\": [task ids]}]}. " +
    "Return a JSON plan with EXACTLY the keys mode and steps: {\"mode\": \"single\" or \"multi\", \"steps\": [task ids in execution order]}. No other keys. " +
    "You may run ANY subset of the tasks, but every chosen task's deps must also be chosen and appear EARLIER in steps; no task may appear twice. " +
    "SINGLE: one generalist agent runs the steps one after another; each task costs ceil(cost * 1.4) and takes its time. " +
    "MULTI: each task runs on the agent of its pillar. Different pillar agents run in parallel, but one pillar agent runs one task at a time, in the order given. " +
    "A task starts when its agent is free and all its deps have finished, plus 1 extra time unit for every dep that was run by a DIFFERENT pillar agent (handoff wait). " +
    "In multi mode a task that has at least one dep run by a different pillar agent also costs an extra 'handoff' (once per task). A multi task otherwise costs its cost. " +
    "The total cost must not exceed budget. " +
    "SCORE = (sum of the values of the chosen tasks) - 0.5 * makespan, where makespan is the finish time of the last step (0 if there are no steps). Maximise it. " +
    "A plan counts as correct only if it is valid, scores at least as much as the best possible SINGLE plan, and is within 10% of the best possible plan overall.",
  visible: ORCH_VISIBLE,
  field: ORCH_FIELD,
  baselineCode: `import json
def normalize(raw):
    job = json.loads(raw)
    chosen = []
    cost = 0
    for t in job["tasks"]:
        if all(d in chosen for d in t["deps"]):
            c = (t["cost"] * 14 + 9) // 10
            if cost + c <= job["budget"]:
                chosen.append(t["id"])
                cost += c
    return json.dumps({"mode": "single", "steps": chosen})
`,
};

export const FAMILIES: Record<Family, FamilySpec> = { dates, money, durations, command, context, govern, orchestrate };
export const FAMILY_LIST: Family[] = ["dates", "money", "durations", "command", "context", "govern", "orchestrate"];

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function equalValue(a: unknown, b: string | number): boolean {
  return typeof a === typeof b && a === b;
}

/** Cross-pillar interference check: a promotion in one of these pillars is re-scored together with the CURRENT tool of its
 *  partner on a sealed end-to-end set (user message -> Command -> action -> Govern -> final decision). */
export const PARTNER: Partial<Record<Family, Family>> = { command: "govern", govern: "command" };
