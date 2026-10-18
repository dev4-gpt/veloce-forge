// Independent reference implementations of each pillar's WRITTEN rules. They are NOT used by the product.
// They exist so a test can prove that every benchmark label is consistent with the rules in the task text
// (an inconsistent label would silently punish a correct tool).
export const REFERENCE: Record<string, string> = {
  command: `import re
def normalize(raw):
    t = raw.lower()
    words = re.findall(r"[a-z']+", t)
    esc = {"lawyer","lawyers","attorney","sue","suing","lawsuit","legal","chargeback","chargebacks","regulator","manager","supervisor","human"}
    if any(w in esc for w in words):
        return "escalate"
    if any(w.startswith("refund") or w.startswith("reimburs") for w in words) or "money back" in t:
        return "refund"
    if any(w.startswith("cancel") or w in ("terminate","unsubscribe") for w in words) or "stop my" in t:
        return "cancel"
    if any(w in ("report","reports","export","analytics") or w.startswith("summar") for w in words):
        return "report"
    if any(w in ("status","track","tracking","progress") for w in words) or "where is" in t or "where's" in t:
        return "status"
    return "unknown"
`,
  context: `import re
DOCS = {
  "refund-policy": ["refund","refunds","return","returns","money","back","days"],
  "shipping": ["shipping","ship","delivery","deliver","courier","tracking","days"],
  "pricing": ["price","prices","pricing","cost","plan","plans","fee","subscription"],
  "security": ["password","security","2fa","login","breach","encryption"],
  "api": ["api","key","keys","token","endpoint","rate","limit"],
  "onboarding": ["onboarding","start","setup","getting","started","welcome","invite"],
  "billing": ["invoice","invoices","billing","payment","card","charged"],
  "support": ["support","help","contact","hours","phone","email"],
}
def normalize(raw):
    words = re.findall(r"[a-z0-9]+", raw.lower())
    best, best_score = "none", 0
    for doc in sorted(DOCS):
        score = 0
        for kw in DOCS[doc]:
            if any(w == kw or (len(kw) >= 4 and w.startswith(kw)) for w in words):
                score += 1
        if score > best_score:
            best, best_score = doc, score
    return best
`,
  govern: `import re
def normalize(raw):
    fields = {}
    for tok in raw.split():
        if "=" in tok:
            k, v = tok.split("=", 1)
            fields[k] = v
    action = fields.get("action", "")
    def num(key):
        try:
            return int(fields[key])
        except Exception:
            return None
    if action in ("delete_database","disable_audit","export_all_customers"):
        return "block"
    if action in ("send_email","post_social","charge_card") and fields.get("approved") != "yes":
        return "block"
    a = num("amount")
    if a is not None and a > 500:
        return "flag"
    r = num("recipients")
    if r is not None and r > 100:
        return "flag"
    low = raw.lower()
    if "password" in low or re.search(r"\\bssn\\b", low):
        return "flag"
    return "allow"
`,
  orchestrate: `import json, itertools
def sim(job, order, mode):
    t = {x["id"]: x for x in job["tasks"]}
    fin, free = {}, {}
    cost = value = span = clock = 0
    for i in order:
        x = t[i]
        value += x["value"]
        if mode == "single":
            cost += (x["cost"] * 14 + 9) // 10
            clock += x["time"]
            fin[i] = clock
            span = clock
        else:
            ready, crossed = 0, False
            for d in x["deps"]:
                diff = t[d]["pillar"] != x["pillar"]
                crossed = crossed or diff
                ready = max(ready, fin[d] + (1 if diff else 0))
            start = max(free.get(x["pillar"], 0), ready)
            end = start + x["time"]
            free[x["pillar"]] = end
            fin[i] = end
            span = max(span, end)
            cost += x["cost"] + (job["handoff"] if crossed else 0)
    return cost, 2 * value - span
def normalize(raw):
    job = json.loads(raw)
    t = {x["id"]: x for x in job["tasks"]}
    ids = [x["id"] for x in job["tasks"]]
    best = (0, "single", [])
    for r in range(1, len(ids) + 1):
        for sub in itertools.combinations(ids, r):
            s = set(sub)
            if any(d not in s for i in sub for d in t[i]["deps"]):
                continue
            for order in itertools.permutations(sub):
                pos = {x: k for k, x in enumerate(order)}
                if any(pos[d] > pos[i] for i in order for d in t[i]["deps"]):
                    continue
                for mode in ("single", "multi"):
                    c, net = sim(job, order, mode)
                    if c <= job["budget"] and net > best[0]:
                        best = (net, mode, list(order))
    return json.dumps({"mode": best[1], "steps": best[2]})
`,
};

// Added for the fresh-audit check: independent references for the three data-normalising families, so every label in
// visible, field, held-out and audit sets can be checked against the WRITTEN rules (see tests/audit.test.ts).
REFERENCE.dates = String.raw`import re, datetime
MONTHS = {m: i + 1 for i, m in enumerate("january february march april may june july august september october november december".split())}
for k in list(MONTHS):
    MONTHS[k[:3]] = MONTHS[k]
WEEKDAYS = {"monday","mon","tuesday","tue","tues","wednesday","wed","thursday","thu","thur","thurs","friday","fri","saturday","sat","sunday","sun"}
def mk(y, m, d):
    if y < 100:
        y += 2000
    return datetime.date(y, m, d).isoformat()
def normalize(raw):
    s = raw.strip()
    parts = re.split(r"[,\s]+", s, maxsplit=1)
    if len(parts) == 2 and parts[0].lower().rstrip(".") in WEEKDAYS:
        s = parts[1].strip()
    m = re.fullmatch(r"(\d{4})[-./](\d{1,2})[-./](\d{1,2})", s)
    if m:
        return mk(int(m[1]), int(m[2]), int(m[3]))
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4}|\d{2})", s)
    if m:
        return mk(int(m[3]), int(m[1]), int(m[2]))
    m = re.fullmatch(r"(\d{1,2})(?:st|nd|rd|th)?[- ]+([A-Za-z]+)\.?[-, ]+(\d{4}|\d{2})", s)
    if m and m[2].lower() in MONTHS:
        return mk(int(m[3]), MONTHS[m[2].lower()], int(m[1]))
    m = re.fullmatch(r"([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}|\d{2})", s)
    if m and m[1].lower() in MONTHS:
        return mk(int(m[3]), MONTHS[m[1].lower()], int(m[2]))
    raise ValueError("not a date")
`;

REFERENCE.money = String.raw`import re
def normalize(raw):
    s = raw.strip()
    neg = False
    if s.startswith("(") and s.endswith(")"):
        neg = True
        s = s[1:-1].strip()
    if s.startswith("-"):
        neg = True
        s = s[1:].strip()
    if s.endswith("¢"):
        digits = re.sub(r"[^0-9]", "", s)
        if not digits:
            raise ValueError("no amount")
        v = int(digits)
        return -v if neg else v
    s = re.sub(r"(?i)usd|eur|gbp|[$€£]", "", s).strip()
    if s.startswith("-"):
        neg = True
        s = s[1:].strip()
    if not re.fullmatch(r"[0-9.,\s]+", s) or not re.search(r"[0-9]", s):
        raise ValueError("no amount")
    s = s.replace(" ", "")
    has_c, has_d = "," in s, "." in s
    dec = None
    if has_c and has_d:
        dec = "," if s.rfind(",") > s.rfind(".") else "."
    elif has_c or has_d:
        sep = "," if has_c else "."
        if len(s.split(sep)[-1]) in (1, 2):
            dec = sep
    if dec:
        i = s.rfind(dec)
        whole = re.sub(r"[.,]", "", s[:i]) or "0"
        frac = s[i + 1:]
        cents = int(whole) * 100 + int(frac.ljust(2, "0")[:2])
    else:
        cents = int(re.sub(r"[.,]", "", s)) * 100
    return -cents if neg else cents
`;

REFERENCE.durations = String.raw`import re
from decimal import Decimal, ROUND_HALF_UP
UNIT = {"d": 1440, "day": 1440, "days": 1440, "h": 60, "hr": 60, "hrs": 60, "hour": 60, "hours": 60,
        "m": 1, "min": 1, "mins": 1, "minute": 1, "minutes": 1, "s": Decimal(1) / 60, "sec": Decimal(1) / 60, "secs": Decimal(1) / 60,
        "second": Decimal(1) / 60, "seconds": Decimal(1) / 60}
def rnd(x):
    return int(Decimal(x).quantize(Decimal(1), rounding=ROUND_HALF_UP))
def normalize(raw):
    s = raw.strip().lower()
    m = re.fullmatch(r"pt(?:([0-9.]+)h)?(?:([0-9.]+)m)?(?:([0-9.]+)s)?", s)
    if m and any(m.groups()):
        h, mi, se = (Decimal(g) if g else Decimal(0) for g in m.groups())
        return rnd(h * 60 + mi + se / 60)
    m = re.fullmatch(r"([0-9]+):([0-9]{2})(?::([0-9]{2}))?", s)
    if m:
        return rnd(Decimal(int(m[1])) * 60 + int(m[2]) + Decimal(int(m[3] or 0)) / 60)
    if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", s):
        return rnd(Decimal(s))
    total = Decimal(0)
    rest = s
    found = False
    for m in re.finditer(r"([0-9]+(?:\.[0-9]+)?)\s*([a-z]+)", s):
        if m[2] not in UNIT:
            raise ValueError("unit")
        total += Decimal(m[1]) * UNIT[m[2]]
        found = True
    if not found or re.sub(r"([0-9]+(?:\.[0-9]+)?)\s*([a-z]+)|\s", "", s):
        raise ValueError("unparsed")
    return rnd(total)
`;
