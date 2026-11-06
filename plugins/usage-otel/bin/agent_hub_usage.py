"""agent-hub usage --session <id> [--json] [--dir D] | --all
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


def summarize(path):
    import json
    prov, tot = {}, {"in": 0, "out": 0, "cached": 0, "cost_usd": 0.0, "credits": 0.0, "n": 0}
    try:
        f = open(path, "r", encoding="utf-8")
    except OSError:
        return {"providers": prov, "total": tot}
    with f:
        for line in f:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            p = prov.setdefault(r.get("provider", ""), {"in": 0, "out": 0, "cached": 0, "cost_usd": 0.0, "credits": 0.0, "n": 0})
            for d in (p, tot):
                d["in"] += r.get("in", 0); d["out"] += r.get("out", 0); d["cached"] += r.get("cached", 0)
                d["cost_usd"] += r.get("cost_usd", 0.0); d["credits"] += r.get("credits", 0.0); d["n"] += 1
    return {"providers": prov, "total": tot}


def main(argv):
    if argv and argv[0] == "usage":
        argv = argv[1:]
    opt = lambda n: argv[argv.index(n) + 1] if n in argv and argv.index(n) + 1 < len(argv) else None
    d = opt("--dir") or usage_dir()
    sid = opt("--session")
    if not sid and "--all" not in argv:
        sys.stderr.write("usage: agent-hub usage --session <id> [--json] [--dir D] | --all\n")
        return 2
    out = None
    if "--all" not in argv:
        try:  # fast path: the plugin keeps a ready summary per session, so --json needs no parsing at all
            with open(os.path.join(d, "sessions", safe(sid) + ".sum.json"), "r", encoding="utf-8") as f:
                raw = f.read()
            if "--json" in argv:
                sys.stdout.write(raw + "\n")
                return 0
            import json
            out = json.loads(raw)
        except OSError:
            pass
    if out is None:  # no summary yet (older data, or --all): scan the log
        import json
        out = summarize(os.path.join(d, "usage.jsonl") if "--all" in argv else os.path.join(d, "sessions", safe(sid) + ".jsonl"))
        out["session"] = sid or "*"
    if "--json" in argv:
        sys.stdout.write(json.dumps(out) + "\n")
    else:
        parts = ["%s %d" % (k, v["in"] + v["out"]) for k, v in sorted(out["providers"].items())]
        t = out["total"]
        sys.stdout.write("hub  %s | %.2fcr ~$%.2f\n" % (" | ".join(parts) or "0", t["credits"], t["cost_usd"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
