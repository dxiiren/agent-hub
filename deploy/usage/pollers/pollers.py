"""Agent Hub pollers: one small HTTP service exposing Prometheus text for sources that have no OTLP.

POLLERS=limits,qoder,opencode (default all). Port PORT (9109). Each poller refreshes in its own thread and
the handler serves the cached text, so Prometheus never waits on a slow CLI. Counts only, never prompt text.
  limits   : Claude/Codex 5h + weekly % from the Usage Monitor (USAGE_MONITOR_URL/_USER/_PASS from env only)
  qoder    : runs plugins/usage-otel/pollers/qoder_poll.py (piece A): credits used / remaining / today, reset date
  opencode : runs plugins/usage-otel/pollers/opencode_export.py (piece A): tokens per provider/model
"""
import http.cookiejar, json, os, subprocess, sys, threading, time, urllib.parse, urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEV = os.environ.get("HUB_DEV", "unknown")
CACHE = {}  # poller name -> (list of metric lines, ok, unix time)


def esc(v):
    return str(v).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def line(name, value, **labels):
    lab = ",".join('%s="%s"' % (k, esc(v)) for k, v in labels.items())
    return "%s{%s} %s" % (name, lab, value)


def to_epoch(v):
    if isinstance(v, (int, float)):
        return v / 1000 if v > 1e11 else v
    return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()


def limits():
    base = os.environ.get("USAGE_MONITOR_URL", "http://127.0.0.1:47291")
    user, pw = os.environ.get("USAGE_MONITOR_USER"), os.environ.get("USAGE_MONITOR_PASS")
    if not (user and pw):
        raise RuntimeError("USAGE_MONITOR_USER / USAGE_MONITOR_PASS not set")
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    form = urllib.parse.urlencode({"username": user, "password": pw}).encode()  # form-encoded; JSON returns 415
    op.open(urllib.request.Request(base + "/login", form, {"content-type": "application/x-www-form-urlencoded", "Origin": base}), timeout=10)
    out = []
    for i, a in enumerate(json.loads(op.open(base + "/api/accounts", timeout=10).read())["accounts"]):
        u = a.get("usage") or {}
        plan = a.get("provider") or a.get("plan") or a.get("type") or "unknown"
        state = (a.get("status") or {}).get("state", "unknown")
        for w in ("weekly", "session"):  # never export email or config dir
            x = u.get(w)
            if isinstance(x, dict) and x.get("percentage") is not None:
                lab = dict(account="acct%d" % i, plan=plan, window=w, state=state)
                out.append(line("usage_limit_percent", x["percentage"], **lab))
                if x.get("resetsAt"):
                    out.append(line("usage_limit_reset_timestamp_seconds", int(to_epoch(x["resetsAt"])), **lab))
    return out


# Qoder and OpenCode are NOT implemented here: piece A (plugins/usage-otel/pollers/) owns the scripts, we only run them.
SCRIPTS = Path(os.environ.get("AGENT_HUB_POLLER_DIR") or Path(__file__).resolve().parents[3] / "plugins" / "usage-otel" / "pollers")


def run_script(name, *args):
    r = subprocess.run([sys.executable, str(SCRIPTS / name), *args], capture_output=True, text=True, timeout=180, stdin=subprocess.DEVNULL)
    if r.returncode:
        raise RuntimeError("%s exit %d: %s" % (name, r.returncode, r.stderr.strip()[-300:]))
    return r.stdout


def qoder():
    # qoder_poll.py prints one JSON line (balance, used, remaining, reset_time, credits_used_today)
    s = json.loads(run_script("qoder_poll.py", "--dev", DEV))
    out = []
    for k in ("credits_used", "credits_remaining", "credits_used_today"):
        if s.get(k) is not None:
            out.append(line(k, s[k], provider="qoder", dev=DEV))
    if s.get("reset_time"):
        out.append(line("credits_reset_timestamp_seconds", int(to_epoch(s["reset_time"])), provider="qoder", dev=DEV))
    return out


def opencode():
    # opencode_export.py prints opencode_tokens_total{provider,model,type,dev} lines; export is slow, so this runs every 5 min
    return [x for x in run_script("opencode_export.py", "--dev", DEV).splitlines() if x]


ALL = {"limits": (limits, 60), "qoder": (qoder, 300), "opencode": (opencode, 300)}


def loop(name, fn, every):
    while True:
        try:
            CACHE[name] = (fn(), True, time.time())
        except Exception as e:  # keep the last good lines, flag the poller down
            old = CACHE.get(name, ([], False, 0))
            CACHE[name] = (old[0], False, old[2])
            print("poller %s failed: %s %s" % (name, type(e).__name__, str(e)[:300]), flush=True)
        time.sleep(every)


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = []
        for n, (lines, ok, ts) in sorted(CACHE.items()):
            body += lines + [line("hub_poller_up", int(ok), poller=n)]
            if ts:
                body.append(line("hub_poller_last_success_timestamp_seconds", int(ts), poller=n))
        data = ("\n".join(body) + "\n").encode()
        self.send_response(200)
        self.send_header("content-type", "text/plain; version=0.0.4")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    for n in os.environ.get("POLLERS", ",".join(ALL)).split(","):
        threading.Thread(target=loop, args=(n.strip(), *ALL[n.strip()]), daemon=True).start()
    ThreadingHTTPServer((os.environ.get("BIND", "0.0.0.0"), int(os.environ.get("PORT", "9109"))), H).serve_forever()
