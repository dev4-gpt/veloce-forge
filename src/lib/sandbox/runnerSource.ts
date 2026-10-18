// Trusted runner uploaded to the sandbox by the server. It imports the candidate module and prints
// ONLY the candidate's outputs. It never receives expected values, so the candidate cannot self-report.
export const RUNNER_PY = `import sys, json, importlib.util, signal

class Timeout(Exception):
    pass

def _on_alarm(signum, frame):
    raise Timeout()

signal.signal(signal.SIGALRM, _on_alarm)
payload = json.load(sys.stdin)
real_stdout = sys.stdout
sys.stdout = sys.stderr  # anything the candidate prints goes to stderr, not into our result

try:
    spec = importlib.util.spec_from_file_location("candidate", "/workspace/candidate.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    fn = getattr(mod, "normalize")
except BaseException as e:
    sys.stdout = real_stdout
    print(json.dumps({"load_error": (type(e).__name__ + ": " + str(e))[:200]}))
    sys.exit(0)

out = []
for x in payload["inputs"]:
    signal.alarm(2)
    try:
        v = fn(x)
        json.dumps(v)
        out.append({"ok": v})
    except Timeout:
        out.append({"err": "timeout"})
    except BaseException as e:
        out.append({"err": (type(e).__name__ + ": " + str(e))[:80]})
    finally:
        signal.alarm(0)

sys.stdout = real_stdout
print(json.dumps({"outputs": out}))
`;

// Trusted end-to-end pipeline runner. Loads TWO tool modules (Command and Govern) from a directory, runs each case
// "<message> | <extra fields>" through Command, maps the intent to an action with a FIXED table, builds a log line and
// runs it through Govern. It prints outputs only and never sees expected values.
export const PIPELINE_PY = `import sys, json, importlib.util, signal

ACTIONS = {"escalate": "send_email", "refund": "charge_card", "report": "send_email",
           "cancel": "cancel_subscription", "status": "lookup", "unknown": "noop"}
DIR = sys.argv[1] if len(sys.argv) > 1 else "/workspace"

class Timeout(Exception):
    pass

def _on_alarm(signum, frame):
    raise Timeout()

signal.signal(signal.SIGALRM, _on_alarm)
payload = json.load(sys.stdin)
real_stdout = sys.stdout
sys.stdout = sys.stderr

def load(name):
    spec = importlib.util.spec_from_file_location(name, DIR + "/" + name + ".py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return getattr(mod, "normalize")

try:
    command = load("pipe_command")
    govern = load("pipe_govern")
except BaseException as e:
    sys.stdout = real_stdout
    print(json.dumps({"load_error": (type(e).__name__ + ": " + str(e))[:200]}))
    sys.exit(0)

out = []
for x in payload["inputs"]:
    message, _, extra = x.partition(" | ")
    signal.alarm(3)
    try:
        intent = command(message)
        action = ACTIONS.get(intent)
        if action is None:
            out.append({"err": "bad intent"})
        else:
            line = "agent=assistant action=" + action + ((" " + extra) if extra else "")
            decision = govern(line)
            json.dumps(decision)
            out.append({"ok": decision})
    except Timeout:
        out.append({"err": "timeout"})
    except BaseException as e:
        out.append({"err": (type(e).__name__ + ": " + str(e))[:80]})
    finally:
        signal.alarm(0)

sys.stdout = real_stdout
print(json.dumps({"outputs": out}))
`;
