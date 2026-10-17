// Synthetic benchmark: three "messy field" normalizers. Visible cases are shown to the agent
// (input, expected, got) when it fails them. Held-out cases are NEVER shown: only the raw
// inputs go to the sandbox; expected values stay on the server and are used only by the gate.
import { createHash } from "node:crypto";

export type Family = "dates" | "money" | "durations";
export type Case = { input: string; expected: string | number };

export interface FamilySpec {
  family: Family;
  title: string;
  instruction: string;
  visible: Case[];
  field: Case[]; // "field reports": user-flagged failures; shown to the agent in later rounds; disjoint from held-out
  heldout: Case[];
  baselineCode: string; // library v0: deliberately naive
}

const dates: FamilySpec = {
  family: "dates",
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
  heldout: [
    { input: "2026.10.05", expected: "2026-10-05" },
    { input: "05-Oct-26", expected: "2026-10-05" },
    { input: "October 5th, 2026", expected: "2026-10-05" },
    { input: "10/5/26", expected: "2026-10-05" },
    { input: "2026/10/05", expected: "2026-10-05" },
    { input: "Monday, October 5, 2026", expected: "2026-10-05" },
    { input: "5-Oct-2026", expected: "2026-10-05" },
    { input: "1st March 2025", expected: "2025-03-01" },
    { input: "Dec 31 2024", expected: "2024-12-31" },
    { input: "2/29/2024", expected: "2024-02-29" },
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
  heldout: [
    { input: "1.234,50 €", expected: 123450 },
    { input: "EUR 7,5", expected: 750 },
    { input: "$ 1 234.00", expected: 123400 },
    { input: "(12.00)", expected: -1200 },
    { input: "£1,000", expected: 100000 },
    { input: "€ 9,99", expected: 999 },
    { input: "1,234", expected: 123400 },
    { input: "0,50 EUR", expected: 50 },
    { input: "USD 1,234,567.89", expected: 123456789 },
    { input: "$.75", expected: 75 },
  ],
  baselineCode: `def normalize(raw):
    s = raw.replace("$", "").replace(",", "").strip()
    return int(round(float(s) * 100))
`,
};

const durations: FamilySpec = {
  family: "durations",
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
  heldout: [
    { input: "1.5 hrs", expected: 90 },
    { input: "1:30", expected: 90 },
    { input: "PT1H30M", expected: 90 },
    { input: "3600 s", expected: 60 },
    { input: "2h 5m", expected: 125 },
    { input: "0.25h", expected: 15 },
    { input: "1 day", expected: 1440 },
    { input: "90", expected: 90 },
    { input: "1:05:00", expected: 65 },
    { input: "45 minutes", expected: 45 },
  ],
  baselineCode: `def normalize(raw):
    s = raw.strip().lower()
    if s.endswith("m") and s[:-1].isdigit():
        return int(s[:-1])
    raise ValueError("unsupported duration format")
`,
};

export const FAMILIES: Record<Family, FamilySpec> = { dates, money, durations };
export const FAMILY_LIST: Family[] = ["dates", "money", "durations"];

/** Commitment to the held-out set; show it in the UI so it is visibly fixed before any candidate runs. */
export function heldoutHash(family: Family): string {
  return createHash("sha256").update(JSON.stringify(FAMILIES[family].heldout)).digest("hex");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function equalValue(a: unknown, b: string | number): boolean {
  return typeof a === typeof b && a === b;
}
