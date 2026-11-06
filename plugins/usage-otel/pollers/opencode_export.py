"""OpenCode export poller: its OTel carries no token attributes, so read `opencode session list` + `opencode export <id>`.
Prints Prometheus text (default) or JSON (--json). Use the same XDG dirs the OpenCode provider runs with
(env AGENT_HUB_OC_XDG_CONFIG / _DATA / _CACHE). `opencode export` is slow: cache the output if you serve it to a scraper.
Usage: opencode_export.py [--json] [--dev NAME]"""
import json, os, re, subprocess, sys


def totals(sessions):
    """sessions: list of exported session dicts -> {(provider, model): {input, output, cache_read}}"""
    tot = {}
    for d in sessions:
        for m in d.get("messages", []):
            i = m.get("info", {})
            if i.get("role") != "assistant":
                continue
            t = i.get("tokens", {})
            a = tot.setdefault((i.get("providerID", ""), i.get("modelID", "")), {"input": 0, "output": 0, "cache_read": 0})
            a["input"] += t.get("input", 0)
            a["output"] += t.get("output", 0)
            a["cache_read"] += (t.get("cache") or {}).get("read", 0)
    return tot


def prom(tot, dev):
    return "".join('opencode_tokens_total{provider="%s",model="%s",type="%s",dev="%s"} %d\n' % (p, m, ty, dev, v)
                   for (p, m), a in sorted(tot.items()) for ty, v in a.items())


SAFE_ARG = re.compile(r"^[A-Za-z0-9_.:/@=,+-]+$")  # shell=True is only for the Windows .cmd shim: no argument may carry a cmd.exe metacharacter


def oc(*args):
    for a in args:
        if not SAFE_ARG.match(str(a)):
            raise ValueError("unsafe opencode argument refused")
    env = dict(os.environ)
    for src, dst in (("AGENT_HUB_OC_XDG_CONFIG", "XDG_CONFIG_HOME"), ("AGENT_HUB_OC_XDG_DATA", "XDG_DATA_HOME"), ("AGENT_HUB_OC_XDG_CACHE", "XDG_CACHE_HOME")):
        if os.environ.get(src):
            env[dst] = os.environ[src]
    env["OPENCODE_DISABLE_MODELS_FETCH"] = "1"
    return subprocess.run(["opencode", *args], capture_output=True, text=True, env=env, shell=(os.name == "nt"), timeout=120).stdout


def session_ids(text):
    """Empty output (no sessions yet) means zero sessions, not an error."""
    text = (text or "").strip()
    return json.loads(text) if text else []


def main(argv):
    dev = argv[argv.index("--dev") + 1] if "--dev" in argv else os.environ.get("AGENT_HUB_DEV", "")
    sessions = [json.loads(oc("export", s["id"])) for s in session_ids(oc("session", "list", "--format", "json"))]
    tot = totals(sessions)
    if "--json" in argv:
        sys.stdout.write(json.dumps([{"provider": p, "model": m, **a} for (p, m), a in sorted(tot.items())]) + "\n")
    else:
        sys.stdout.write(prom(tot, dev))


if __name__ == "__main__":
    main(sys.argv[1:])
