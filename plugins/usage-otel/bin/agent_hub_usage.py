"""agent-hub usage --session <id> [--json] [--by model] [--dir D] | --all
Reads the per-session usage file written by the usage plugin. Stdlib only, no heavy imports: statusline budget is 60 ms."""
import os, re, sys


def usage_dir():
    d = os.environ.get("AGENT_HUB_USAGE_DIR")
    if d:
        return d
    return os.path.join(os.environ.get("PASEO_HOME") or os.path.join(os.path.expanduser("~"), ".paseo"), "usage")


def safe(s):
    # same rule as usage.mjs safe(): ASCII only, and a Windows device name (CON, NUL, COM1 ..., any extension) gets a "_" prefix
    t = re.sub(r"[^A-Za-z0-9._-]", "_", s)[:80]
    return "_" + t if re.match(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])([.].*)?$", t, re.S) else t


SHORT = {"efficient": "ef", "dfmodel": "df", "qfmodel": "qf", "qmodel_latest": "q4"}  # qoder tiers as the W3 reports name them


def model_key(r):
    """provider/model family for the --by model view: a qoder model is one name whether it came from a usage record (dfmodel) or a backfill line (qoder-dfmodel)."""
    prov, m = r.get("provider", ""), str(r.get("model") or "?")
    if prov == "qoder":
        m = re.sub(r"^qoder[-/]", "", m)
        return SHORT.get(m, m)
    return m if m != "?" else prov


def add(table, key, r):
    d = table.setdefault(key, {"in": 0, "out": 0, "cached": 0, "cost_usd": 0.0, "credits": 0.0, "n": 0})
    d["in"] += r.get("in", 0); d["out"] += r.get("out", 0); d["cached"] += r.get("cached", 0)
    d["cost_usd"] += r.get("cost_usd", 0.0); d["credits"] += r.get("credits", 0.0); d["n"] += 1


def summarize(path):
    import json
    models = {}
    prov, tot = {}, {"in": 0, "out": 0, "cached": 0, "cost_usd": 0.0, "credits": 0.0, "n": 0}
    try:
        f = open(path, "r", encoding="utf-8")
    except OSError:
        return {"providers": prov, "models": models, "total": tot}
    with f:
        for line in f:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            add(models, model_key(r), r)
            p = prov.setdefault(r.get("provider", ""), {"in": 0, "out": 0, "cached": 0, "cost_usd": 0.0, "credits": 0.0, "n": 0})
            for d in (p, tot):
                d["in"] += r.get("in", 0); d["out"] += r.get("out", 0); d["cached"] += r.get("cached", 0)
                d["cost_usd"] += r.get("cost_usd", 0.0); d["credits"] += r.get("credits", 0.0); d["n"] += 1
    return {"providers": prov, "models": models, "total": tot}


def backfilled(d, sid=None):
    """Sidecar usage-backfill-*.jsonl (usage.jsonl is never rewritten). Two line kinds:
    tag   {agent, ts, session}: an existing record of usage.jsonl (no session, or another session's) counts under `session`;
    synth {provider, session, in/out/cost_usd ..., backfill:true}: a run that was never recorded (claude -p, codex exec).
    sid given: the tagged records plus the synth lines of that session; sid None (--all): synth lines only (tagged ones are already in usage.jsonl)."""
    import glob, json
    tag, synth = {}, []
    for fn in sorted(glob.glob(os.path.join(d, "usage-backfill-*.jsonl"))):
        with open(fn, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("provider"):
                    if sid is None or r.get("session") == sid:
                        synth.append(r)
                elif sid is not None and r.get("session") == sid:
                    tag[(r.get("agent"), r.get("ts"))] = 1
    out = list(synth)
    if tag:
        with open(os.path.join(d, "usage.jsonl"), "r", encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if (r.get("agent"), r.get("ts")) in tag:
                    out.append(r)
    return out


def fold(out, recs):
    for r in recs:
        add(out.setdefault("models", {}), model_key(r), r)
        p = out["providers"].setdefault(r.get("provider", ""), {"in": 0, "out": 0, "cached": 0, "cost_usd": 0.0, "credits": 0.0, "n": 0})
        for dd in (p, out["total"]):
            dd["in"] += r.get("in", 0); dd["out"] += r.get("out", 0); dd["cached"] += r.get("cached", 0)
            dd["cost_usd"] += r.get("cost_usd", 0.0); dd["credits"] += r.get("credits", 0.0); dd["n"] += 1


def live_counts(d):
    """{route, claude, codex, paseo}: live markers in <usage dir>/active (pid alive, touched < 1800 s ago); direct runs carry "direct": true."""
    import json, time
    c = {"route": 0, "claude": 0, "codex": 0, "paseo": 0}
    a = os.path.join(d, "active")
    try:
        names = os.listdir(a)
    except OSError:
        return c
    for n in names:
        try:
            p = os.path.join(a, n)
            if not n.startswith("t-") or time.time() - os.path.getmtime(p) >= 1800 or not _pid_alive(int(n.split("-")[1].split(".")[0])):
                continue
            m = json.load(open(p, encoding="utf-8"))
            if m.get("direct"):
                k = {"claude-headless": "claude", "codex-direct": "codex", "paseo-direct": "paseo"}.get(m.get("provider"))
                if k:
                    c[k] += 1
            elif m.get("provider"):
                c["route"] += 1
        except Exception:
            continue
    return c


def _pid_alive(pid):
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    import ctypes
    k = ctypes.windll.kernel32
    h = k.OpenProcess(0x1000, 0, pid)
    if not h:
        return k.GetLastError() == 5
    code = ctypes.c_ulong()
    ok = k.GetExitCodeProcess(h, ctypes.byref(code))
    k.CloseHandle(h)
    return (not ok) or code.value == 259


def main(argv):
    if argv and argv[0] == "usage":
        argv = argv[1:]
    opt = lambda n: argv[argv.index(n) + 1] if n in argv and argv.index(n) + 1 < len(argv) else None
    d = opt("--dir") or usage_dir()
    sid = opt("--session") or (None if "--help" in argv or "-h" in argv else os.environ.get("AGENT_HUB_SESSION") or os.environ.get("CLAUDE_CODE_SESSION_ID"))
    if not sid and "--all" not in argv:
        sys.stderr.write("usage: agent-hub usage --session <id> [--json] [--by model] [--dir D] | --all\n")
        return 2
    out = None
    by_model = opt("--by") == "model"
    if "--all" not in argv and not by_model:  # --by model needs the per-record model, which the ready summary does not keep
        try:  # fast path: the plugin keeps a ready summary per session, so --json needs no parsing at all
            with open(os.path.join(d, "sessions", safe(sid) + ".sum.json"), "r", encoding="utf-8") as f:
                raw = f.read()
            import glob, json
            if "--json" in argv and not glob.glob(os.path.join(d, "usage-backfill-*.jsonl")):
                sys.stdout.write(raw + chr(10))
                return 0
            out = json.loads(raw)
        except OSError:
            pass
    if out is None:  # no summary yet (older data, or --all): scan the log
        import json
        out = summarize(os.path.join(d, "usage.jsonl") if "--all" in argv else os.path.join(d, "sessions", safe(sid) + ".jsonl"))
        out["session"] = sid or "*"
    fold(out, backfilled(d, None if "--all" in argv else sid))
    import json
    if "--all" in argv:
        out["live"] = live_counts(d)
    if "--json" in argv:
        sys.stdout.write(json.dumps(out) + "\n")
    elif by_model:
        parts = ["%s %d runs %dtok %.2fcr" % (k, v["n"], v["in"] + v["out"], v["credits"]) for k, v in sorted(out.get("models", {}).items(), key=lambda kv: -kv[1]["n"])]
        sys.stdout.write("hub by model  %s\n" % (" | ".join(parts) or "0"))
    else:
        parts = ["%s %d" % (k, v["in"] + v["out"]) for k, v in sorted(out["providers"].items())]
        t = out["total"]
        sys.stdout.write("hub  %s | %.2fcr ~$%.2f\n" % (" | ".join(parts) or "0", t["credits"], t["cost_usd"]))
        if "--all" in argv:
            lv = out["live"]
            sys.stdout.write("live: route %d | headless claude %d codex %d paseo %d\n" % (lv["route"], lv["claude"], lv["codex"], lv["paseo"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
