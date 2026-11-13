"""agent-hub direct claude|codex|paseo --session <id> [--dev D] [--client C] -- <tool args>
Runs a headless tool directly (a driver "fast path") and records ONE usage line in the same schema the daemon plugin writes,
so `agent-hub usage --session <id>` counts it. stdout/stderr/exit code pass through unchanged.
  claude  forces --output-format json when absent (reads total_cost_usd + usage); text mode prints only the `result` text.
  codex   adds --json when absent (reads turn.completed usage); then stdout is the JSONL event stream.
  paseo   runs `paseo run ...` with --label session/dev/caller so the daemon's usage plugin records it labelled (no record written here).
Stdlib only, ASCII output."""
import getpass, json, os, re, shutil, subprocess, sys, tempfile, threading, time, uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_hub_usage import usage_dir, safe  # noqa: E402

PROVIDER = {"claude": "claude-headless", "codex": "codex-direct"}


def zero():
    return {"in": 0, "out": 0, "cached": 0, "cost_usd": 0.0, "credits": 0.0, "n": 0}


def _locked_sum(base, rec, sid):
    lock = base + ".lock"
    for _ in range(100):
        try:
            os.close(os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            break
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(lock) > 10:
                    os.remove(lock)
            except OSError:
                pass
            time.sleep(0.05)
    try:
        try:
            with open(base + ".sum.json", encoding="utf-8") as f:
                s = json.load(f)
        except (OSError, ValueError):
            s = {"session": sid, "providers": {}, "total": zero()}
        for d in (s["providers"].setdefault(rec["provider"], zero()), s["total"]):
            for k in ("in", "out", "cached", "cost_usd", "credits"):
                d[k] += rec[k]
            d["n"] += 1
        with open(base + ".sum.json", "w", encoding="utf-8") as f:
            json.dump(s, f, separators=(",", ":"))
    finally:
        try:
            os.remove(lock)
        except OSError:
            pass


def append_usage(d, rec, also=None):
    """Same files as usage.mjs appendUsage: global log, per-session log, per-session summary.
    also = the launching Claude session id (CLAUDE_CODE_SESSION_ID) when it differs from rec.session: its per-session view
    (jsonl + sum.json, what the status line reads) gets the row too, but usage.jsonl is written ONCE so `usage --all` stays single-counted."""
    os.makedirs(os.path.join(d, "sessions"), exist_ok=True)
    line = json.dumps(rec, separators=(",", ":")) + "\n"
    with open(os.path.join(d, "usage.jsonl"), "a", encoding="utf-8") as f:
        f.write(line)
    sid = rec.get("session")
    if sid:
        base = os.path.join(d, "sessions", safe(sid))
        with open(base + ".jsonl", "a", encoding="utf-8") as f:
            f.write(line)
        _locked_sum(base, rec, sid)
    if also and also != sid:
        base = os.path.join(d, "sessions", safe(also))
        with open(base + ".jsonl", "a", encoding="utf-8") as f:
            f.write(line)
        _locked_sum(base, rec, also)


def parse_claude(out):
    """-> (agent, model, in, out, cached, cost) from `--output-format json` (one object) or stream-json (last result line)."""
    obj = None
    try:
        obj = json.loads(out)
    except ValueError:
        for ln in reversed(out.splitlines()):
            try:
                o = json.loads(ln)
            except ValueError:
                continue
            if isinstance(o, dict) and o.get("type") == "result":
                obj = o
                break
    if not isinstance(obj, dict) or obj.get("type") != "result":
        return None
    u = obj.get("usage") or {}
    mu = obj.get("modelUsage") or {}
    model = max(mu, key=lambda m: (mu[m].get("outputTokens", 0) + mu[m].get("inputTokens", 0))) if mu else ""
    return (obj.get("session_id") or "", model, int(u.get("input_tokens", 0)) + int(u.get("cache_creation_input_tokens", 0)),
            int(u.get("output_tokens", 0)), int(u.get("cache_read_input_tokens", 0)), float(obj.get("total_cost_usd") or 0), obj)


def parse_codex(out):
    i = o = c = 0
    model, found = "", False
    for ln in out.splitlines():
        try:
            e = json.loads(ln)
        except ValueError:
            continue
        if not isinstance(e, dict):
            continue
        model = e.get("model") or model
        u = e.get("usage") if e.get("type") == "turn.completed" else None
        if isinstance(u, dict):
            found = True
            i += int(u.get("input_tokens", 0)); c += int(u.get("cached_input_tokens", 0)); o += int(u.get("output_tokens", 0))
    return (i, o, c, model) if found else None


def opt_arg(args, name, default=None):
    if name in args and args.index(name) + 1 < len(args):
        return args[args.index(name) + 1]
    return default


def run_dir():
    return os.path.join(os.environ.get("PASEO_HOME") or os.path.join(os.path.expanduser("~"), ".paseo"), "run", "direct")


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def own_entries():
    """Live wrapper records {wrapper, child, tool, session}: the ONLY processes a driver may stop (never match by name: that killed the daemon on 11-11)."""
    out = []
    for fn in os.listdir(run_dir()) if os.path.isdir(run_dir()) else []:
        try:
            e = json.load(open(os.path.join(run_dir(), fn), encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if _alive(e.get("wrapper", 0)):
            out.append(e)
        else:
            try: os.remove(os.path.join(run_dir(), fn))
            except OSError: pass
    return out


def mark_active(provider):
    """Status-line slot marker ~/.paseo/usage/active/t-<wrapper pid> (same shape route.mjs writes); removed on exit. Best effort."""
    try:
        d = os.path.join(usage_dir(), "active")
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, "t-%d" % os.getpid())
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"provider": provider, "direct": True, "ts": int(time.time() * 1000)}, f)
        return p
    except OSError:
        return None


def heartbeat(p):
    """Touch the marker every AGENT_HUB_HEARTBEAT_S (60) so the status line (ignores markers older than 1800 s) keeps a long run visible. Returns the stop event."""
    ev = threading.Event()
    if p:
        iv = float(os.environ.get("AGENT_HUB_HEARTBEAT_S") or 60)
        def beat():
            while not ev.wait(iv):
                try: os.utime(p, None)
                except OSError: pass
        threading.Thread(target=beat, daemon=True).start()
    return ev


def unmark(p, hb=None):
    if hb:
        hb.set()
    if p:
        try:
            os.remove(p)
        except OSError:
            pass


def stop_pid(pid):
    if os.name == "nt":
        subprocess.run(["powershell", "-NoProfile", "-Command", "Stop-Process -Id %d -Force" % pid], capture_output=True)
    else:
        os.kill(pid, 9)


def usage_recorded(rec):
    """A row counts as recorded usage when it carries tokens. Qoder is the one exception: qodercli 1.1.81 reports credits and never tokens (128,050 transcript usage messages, 0 with a token count, 13-11-2026), so credits > 0 is its recorded usage."""
    return bool(rec.get("in") or rec.get("out") or (str(rec.get("provider", "")).startswith("qoder") and float(rec.get("credits") or 0) > 0))


def gate_dir():
    return os.environ.get("AGENT_HUB_GATE_DIR") or os.path.join(os.environ.get("PASEO_HOME") or os.path.join(os.path.expanduser("~"), ".paseo"), "gate")


SHIM = os.path.join(os.path.dirname(os.path.abspath(__file__)), "paseo_run_split.mjs")
AGENT_ID = re.compile(r"^[0-9A-Za-z][0-9A-Za-z-]{7,63}$")


def write_direct_marker(agent_id):
    """Create-then-prompt: <gate>/direct/<agentId>.json, written only after the agent exists (id known) and before its prompt is sent (plugins/gate/server/store.mjs). Keyed by the id alone: no nonce or label exists before the agent does.
    Never overwrites (O_EXCL), never touches a route request."""
    if not AGENT_ID.match(str(agent_id)):
        raise ValueError("not an agent id: %r" % (agent_id,))
    d = os.path.join(gate_dir(), "direct"); os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, agent_id + ".json"), "x") as f:
        json.dump({"ts": int(time.time() * 1000)}, f)


def remove_direct_marker(agent_id):
    try:
        os.remove(os.path.join(gate_dir(), "direct", agent_id + ".json"))
    except (OSError, TypeError):
        pass


def handshake(hs, stop, seen, limit=180):
    """Background: wait for the shim's <hs>.id (the agent exists, unprompted), write that id's marker, then release the prompt with <hs>.go."""
    end = time.time() + limit
    while not stop.is_set() and time.time() < end:
        try:
            with open(hs + ".id", encoding="utf-8") as f:
                aid = f.read().strip()
            write_direct_marker(aid)
            seen.append(aid)
            open(hs + ".go", "w").close()
            return
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            sys.stderr.write("agent-hub direct: could not write the gate marker; the prompt is never sent (fails closed)" + chr(10)); return
        stop.wait(0.05)


def main(argv):
    if argv and argv[0] == "direct":
        argv = argv[1:]
    if argv and argv[0] == "--list":
        for e in own_entries():
            print(json.dumps(e))
        return 0
    if argv and argv[0] == "--kill":  # stops only children this wrapper family started, for one --session
        sid = opt_arg(argv, "--session")
        if not sid:
            sys.stderr.write("usage: agent-hub direct --kill --session <id>" + chr(10)); return 2
        n = 0
        for e in own_entries():
            if e.get("session") == sid and e.get("child"):
                stop_pid(int(e["child"])); n += 1
        print("stopped %d process(es)" % n)
        return 0
    if not argv or argv[0] in ("-h", "--help", "help") or argv[0] not in ("claude", "codex", "paseo"):
        sys.stderr.write("usage: agent-hub direct claude|codex|paseo --session <id> [--dev D] [--client C] -- <tool args>\n")
        return 2
    tool, rest = argv[0], argv[1:]
    if "--" not in rest:
        sys.stderr.write("agent-hub direct: put the tool's own arguments after a -- marker\n")
        return 2
    k = rest.index("--")
    mine, args = rest[:k], rest[k + 1:]
    sid = opt_arg(mine, "--session") or os.environ.get("AGENT_HUB_SESSION") or os.environ.get("CLAUDE_CODE_SESSION_ID")
    if not sid:
        sys.stderr.write("agent-hub direct: --session <id> is required (or AGENT_HUB_SESSION)\n")
        return 2
    dev = opt_arg(mine, "--dev") or os.environ.get("AGENT_HUB_DEV") or getpass.getuser()
    client = opt_arg(mine, "--client") or os.environ.get("AGENT_HUB_CLIENT") or "direct"
    t0 = time.time()
    if tool == "paseo":
        cmd = os.environ.get("AGENT_HUB_DIRECT_PASEO")
        argv2 = [cmd] if cmd else ["node", SHIM]
        if not args or args[0] != "run":
            sys.stderr.write("agent-hub direct paseo: only `run` is labelled; pass: -- run --provider ..." + chr(10))
            return 2
        lab = ["--label", "session=" + sid, "--label", "dev=" + dev, "--label", "caller=" + client, "--label", "route/type=direct"]
        hsdir = tempfile.mkdtemp(prefix="ah-direct-"); hs = os.path.join(hsdir, "h")
        mk = mark_active("paseo-direct")
        hb = heartbeat(mk)
        ok = False; seen = []; stop = threading.Event()
        try:
            threading.Thread(target=handshake, args=(hs, stop, seen), daemon=True).start()
            try:
                rc = subprocess.run(argv2 + [args[0]] + lab + args[1:], env=dict(os.environ, AGENT_HUB_DIRECT_SESSION=sid, AGENT_HUB_DIRECT_PID=str(os.getpid()), AGENT_HUB_DIRECT_HANDSHAKE=hs)).returncode  # paseo agents are archived via `paseo archive <id>`, never killed by name
            finally:
                stop.set()
            ok = rc == 0
            return rc
        finally:
            if not ok:
                for aid in seen:
                    remove_direct_marker(aid)  # a failed run leaves no marker behind (a successful one was consumed by the plugin on that agent's first turn)
            unmark(mk, hb)
            shutil.rmtree(hsdir, ignore_errors=True)
    env_bin = os.environ.get("AGENT_HUB_DIRECT_" + tool.upper())
    exe = env_bin or shutil.which(tool)
    if not exe:
        sys.stderr.write("agent-hub direct: %s not found on PATH\n" % tool)
        return 127
    text_mode = False
    if tool == "claude":
        fmt = opt_arg(args, "--output-format")
        if fmt is None:
            args = args + ["--output-format", "json"]; text_mode = True
        elif fmt == "text":
            args = list(args); args[args.index("--output-format") + 1] = "json"; text_mode = True
    elif "--json" not in args:
        ix = args.index("exec") + 1 if "exec" in args else 0
        args = args[:ix] + ["--json"] + args[ix:]
    os.makedirs(run_dir(), exist_ok=True)
    reg = os.path.join(run_dir(), "%d.json" % os.getpid())
    # runtime backstop marker: claude-fleet-cap lets a headless claude run only when this pair is set, the wrapper pid is an ancestor AND the run is
    # the child recorded below in the registry file (`child`); a bare launch made by that child itself (nested) inherits the env but is refused
    cenv = dict(os.environ, AGENT_HUB_DIRECT_SESSION=sid, AGENT_HUB_DIRECT_PID=str(os.getpid()))
    mk = mark_active(PROVIDER[tool])
    hb = heartbeat(mk)
    proc = subprocess.Popen([exe] + args, stdout=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", env=cenv)
    with open(reg, "w", encoding="utf-8") as f:
        json.dump({"wrapper": os.getpid(), "child": proc.pid, "tool": tool, "session": sid, "ts": time.strftime("%FT%TZ", time.gmtime())}, f)
    out = proc.communicate()[0] or ""
    r = proc
    unmark(mk, hb)
    try: os.remove(reg)
    except OSError: pass
    rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()), "agent": "", "session": sid, "provider": PROVIDER[tool], "model": "",
           "dev": dev, "client": client, "task": "direct", "in": 0, "out": 0, "cached": 0, "cost_usd": 0.0, "credits": 0.0}
    shown = out
    try:
        if tool == "claude":
            p = parse_claude(out)
            if p:
                rec.update(agent=p[0], model=p[1], **{"in": p[2], "out": p[3], "cached": p[4], "cost_usd": p[5]})
                if text_mode:
                    shown = str(p[6].get("result", "")) + "\n"
        else:
            p = parse_codex(out)
            if p:
                rec.update(model=p[3], **{"in": p[0], "out": p[1], "cached": p[2]})
        if r.returncode == 0 and not usage_recorded(rec):
            rec["kind"] = "usage-missing"  # a successful run whose output carried no tokens: recorded loudly, never as a silent zero
            sys.stderr.write("agent-hub direct: usage-missing: %s run succeeded but no token usage was parsed" % tool + chr(10))
        if rec["in"] or rec["out"] or rec["cost_usd"] or rec.get("kind"):  # a failed call with no usage (auth, 403) is not a billed turn
            rec["agent"] = rec["agent"] or "direct-" + uuid.uuid4().hex[:12]
            append_usage(usage_dir(), rec, also=os.environ.get("CLAUDE_CODE_SESSION_ID") or None)
    except Exception as e:  # recording must never break the caller's run
        sys.stderr.write("agent-hub direct: usage record failed: %s\n" % e)
    if hasattr(sys.stdout, "buffer"):
        sys.stdout.buffer.write(shown.encode("utf-8", "replace"))
    else:
        sys.stdout.write(shown)
    sys.stdout.flush()
    return r.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
