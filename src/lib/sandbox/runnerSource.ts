// Trusted code uploaded to the sandbox by the server. NONE of it receives expected values.
//
// Defence in depth for model-written code (the real boundary is still the CreateOS microVM with outbound access blocked):
//   1. AST_SCREEN_PY parses the candidate as a Python syntax tree and REJECTS it without ever running it.
//   2. RUNNER_PY / PIPELINE_PY then execute it with a restricted built-ins table and a restricted __import__, so it cannot
//      reach open(), eval(), os, sys, or the runner's own stdout.
// Patterns here were inspired by the KISS hackathon project (MIT): host-side AST validation, never importing candidate code
// outside a supervisor. This is a re-implementation, not a copy.

/** Static check on the SYNTAX TREE. argv: <file> <json list of allowed top-level modules>. Prints {"ok": bool, "reasons": [...]}. */
export const AST_SCREEN_PY = `import ast, json, sys

path = sys.argv[1]
allowed = set(json.loads(sys.argv[2]))
BANNED_NAMES = {"eval", "exec", "compile", "open", "input", "__import__", "globals", "locals", "vars", "getattr", "setattr",
                "delattr", "breakpoint", "exit", "quit", "help", "memoryview", "Formatter"}
# attribute names that reach the interpreter, other modules, or format-string attribute traversal
BANNED_ATTRS = {"sys", "os", "modules", "builtins", "importlib", "subprocess", "system", "popen", "environ",
                "stdout", "stderr", "stdin", "format", "format_map", "vformat", "get_field", "get_value", "Formatter"}
reasons = []
try:
    src = open(path).read()
except Exception:
    print(json.dumps({"ok": False, "reasons": ["cannot read candidate"]}))
    sys.exit(0)
if len(src) > 8000:
    reasons.append("source too long")
try:
    tree = ast.parse(src)
except SyntaxError:
    print(json.dumps({"ok": False, "reasons": ["syntax error"]}))
    sys.exit(0)
count = 0
for node in ast.walk(tree):
    count += 1
    if isinstance(node, ast.Import):
        for a in node.names:
            top = a.name.split(".")[0]
            if top not in allowed:
                reasons.append("import not allowed: " + top)
    elif isinstance(node, ast.ImportFrom):
        top = (node.module or "").split(".")[0]
        if node.level or not node.module or top not in allowed:
            reasons.append("import not allowed: " + (node.module or "relative"))
        if any(a.name == "*" for a in node.names):
            reasons.append("star import")
    elif isinstance(node, ast.Name):
        if node.id in BANNED_NAMES:
            reasons.append("banned name: " + node.id)
        elif node.id.startswith("__") and node.id.endswith("__"):
            reasons.append("dunder name: " + node.id)
    elif isinstance(node, ast.Attribute):
        if node.attr.startswith("__") and node.attr.endswith("__"):
            reasons.append("dunder attribute: " + node.attr)
        elif node.attr in BANNED_ATTRS:
            reasons.append("banned attribute: " + node.attr)
    elif isinstance(node, ast.Constant) and isinstance(node.value, str) and "__" in node.value:
        reasons.append("string containing a double underscore")
if count > 6000:
    reasons.append("too many syntax nodes")
print(json.dumps({"ok": not reasons, "reasons": sorted(set(reasons))[:8]}))
`;

/** Shared loader used by both runners: execute the candidate with restricted built-ins and a restricted __import__. */
const SAFE_LOADER_PY = `import builtins

_NAMES = ["abs", "all", "any", "ascii", "bin", "bool", "bytearray", "bytes", "callable", "chr", "classmethod", "complex",
          "dict", "divmod", "enumerate", "filter", "float", "format", "frozenset", "hasattr", "hash", "hex", "int",
          "isinstance", "issubclass", "iter", "len", "list", "map", "max", "min", "next", "object", "oct", "ord", "pow",
          "print", "property", "range", "repr", "reversed", "round", "set", "slice", "sorted", "staticmethod", "str", "sum",
          "super", "tuple", "type", "zip", "__build_class__",
          "ArithmeticError", "AssertionError", "AttributeError", "Exception", "IndexError", "KeyError", "LookupError",
          "NotImplementedError", "OverflowError", "RuntimeError", "StopIteration", "TypeError", "UnicodeError",
          "ValueError", "ZeroDivisionError", "ImportError"]

def load_restricted(path, allowed):
    safe = {k: getattr(builtins, k) for k in _NAMES}
    real_import = builtins.__import__
    def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
        if level != 0 or name.split(".")[0] not in allowed:
            raise ImportError("import blocked: " + name)
        return real_import(name, globals, locals, fromlist, level)
    safe["__import__"] = safe_import
    ns = {"__builtins__": safe, "__name__": "candidate"}
    with open(path) as f:
        src = f.read()
    exec(compile(src, "candidate", "exec"), ns)
    return ns["normalize"]
`;

/** Runs ONE tool over a list of inputs and prints its outputs only. argv: <directory>; stdin: {"inputs": [...], "allowed": [...]} */
export const RUNNER_PY = `import sys, json, signal
${SAFE_LOADER_PY}
DIR = sys.argv[1] if len(sys.argv) > 1 else "/workspace"

class Timeout(Exception):
    pass

def _on_alarm(signum, frame):
    raise Timeout()

signal.signal(signal.SIGALRM, _on_alarm)
payload = json.load(sys.stdin)
allowed = set(payload.get("allowed", []))
real_stdout = sys.stdout
sys.stdout = sys.stderr  # anything the candidate prints goes to stderr, never into our result

try:
    fn = load_restricted(DIR + "/candidate.py", allowed)
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
// runs it through Govern. It prints outputs only and never sees expected values. Both tools run with restricted built-ins.
export const PIPELINE_PY = `import sys, json, signal
${SAFE_LOADER_PY}
ACTIONS = {"escalate": "send_email", "refund": "charge_card", "report": "send_email",
           "cancel": "cancel_subscription", "status": "lookup", "unknown": "noop"}
DIR = sys.argv[1] if len(sys.argv) > 1 else "/workspace"

class Timeout(Exception):
    pass

def _on_alarm(signum, frame):
    raise Timeout()

signal.signal(signal.SIGALRM, _on_alarm)
payload = json.load(sys.stdin)
allowed = set(payload.get("allowed", []))
real_stdout = sys.stdout
sys.stdout = sys.stderr

try:
    command = load_restricted(DIR + "/pipe_command.py", allowed)
    govern = load_restricted(DIR + "/pipe_govern.py", allowed)
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
