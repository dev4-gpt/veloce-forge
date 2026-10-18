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
};
