"""Usage summary for desktop widgets: one JSON document on stdout, read-only, stdlib only.

    python agent_hub_widget.py [--dir D] [--config F]

Qoder: the last quota the hub already polled (usage/qoder-last.json); this command never polls Qoder.
Self-hosted Qwen endpoints: up/down from GET <base>/v1/models (cached on disk, default 300 s, so a widget
that asks every few minutes adds no load) plus tokens today (UTC day) and over the last 7 days from usage.jsonl.
No percentage is invented for endpoints that have no plan quota.

Output: {"version":1,"generated":<unix>,"sources":[{"id","name","text"(two lines, \nn),"percent"?,"up"?}]}
"""
import json, os, re, sys, time, urllib.request
from datetime import datetime, timezone


def home():
    return os.environ.get("PASEO_HOME") or os.path.join(os.path.expanduser("~"), ".paseo")


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def fmt(n):
    return "%.1fM" % (n / 1e6) if n >= 1e6 else "%.1fk" % (n / 1e3) if n >= 1e3 else str(n)


def qoder_source(usage_dir, now):
    last = read_json(os.path.join(usage_dir, "qoder-last.json"))
    s = last.get("s") or {}
    used, left = s.get("credits_used"), s.get("credits_remaining")
    if not isinstance(used, (int, float)) or not isinstance(left, (int, float)):
        return None
    limit = used + left
    pct = round(used / limit * 1000) / 10 if limit > 0 else None
    first = ["%g%%" % pct] if pct is not None else []
    reset = s.get("reset_time")
    if reset:
        try:
            first.append("resets " + datetime.fromisoformat(reset).strftime("%d %b"))
        except ValueError:
            pass
    parts = [" - ".join(first), "%s used - %s left" % (fmt(int(used)), fmt(int(left)))]
    age = int(now - last.get("at", 0) / 1000) if last.get("at") else None
    src = {"id": "qoder", "name": "Qoder", "text": "\n".join(p for p in parts if p)}
    if pct is not None:
        src["percent"] = pct
    if age is not None:
        src["age_s"] = age
    return src


def endpoints(config):
    out = []
    for name, p in (config.get("agents", {}).get("providers", {}) or {}).items():
        if name.endswith("-ro") or not re.match(r"^qwen", name):
            continue
        cmd = [str(a) for a in (p.get("command") or [])]
        base = next((a for a in cmd if re.match(r"^https?://", a, re.I)), None)
        port = (p.get("env") or {}).get("LAPTOP_PORT")
        if not base and port:
            base = "http://127.0.0.1:%s/v1" % port
        if not base:
            continue
        host = re.sub(r"^https?://", "", base).split("/")[0].split(":")[0]
        if re.match(r"^\d+\.\d+\.\d+\.\d+$", host) and host != "127.0.0.1":
            tag = host.split(".")[-1]
        elif host in ("127.0.0.1", "localhost", "::1"):
            tag = "laptop"
        else:
            tag = host.split(".")[0]
        out.append({"provider": name, "id": "qwen_" + re.sub(r"[^a-z0-9]+", "_", tag.lower()),
                    "name": "Qwen " + (("." + tag) if tag.isdigit() else tag), "base": base,
                    "key": (p.get("env") or {}).get("HUB_OPENAI_API_KEY")})
    seen = {}
    for ep in out:  # two endpoints on one host tag keep distinct ids and names
        n = seen[ep["id"]] = seen.get(ep["id"], 0) + 1
        if n > 1:
            ep["id"] += "_%d" % n
            ep["name"] += " %d" % n
    return out


def probe(ep, cache, now, ttl):
    hit = cache.get(ep["provider"])
    if hit and now - hit.get("at", 0) < ttl:
        return hit["up"]
    url = re.sub(r"/v1$", "", ep["base"].rstrip("/")) + "/v1/models"
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + ep["key"]} if ep.get("key") else {})
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            up = 200 <= r.status < 300
    except Exception:
        up = False
    cache[ep["provider"]] = {"at": now, "up": up}
    return up


def tally(feed_path, provider, now):
    today = datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d")
    t = w = 0
    try:
        f = open(feed_path, "r", encoding="utf-8")
    except OSError:
        return 0, 0
    with f:
        for line in f:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if str(r.get("provider", "")).replace("-ro", "") != provider:
                continue
            try:
                ts = datetime.fromisoformat(str(r["ts"]).replace("Z", "+00:00")).timestamp()
            except (KeyError, ValueError):
                continue
            if now - ts >= 7 * 86400:
                continue
            n = int(r.get("in") or 0) + int(r.get("out") or 0)
            w += n
            if str(r["ts"])[:10] == today:
                t += n
    return t, w


def build(usage_dir, config, now=None):
    now = now if now is not None else time.time()
    sources = []
    q = qoder_source(usage_dir, now)
    if q:
        sources.append(q)
    cache_path = os.path.join(usage_dir, "widget-probe.json")
    cache = read_json(cache_path)
    ttl = float(os.environ.get("AGENT_HUB_WIDGET_PROBE_TTL", "300"))
    for ep in endpoints(config):
        up = probe(ep, cache, now, ttl)
        today, week = tally(os.path.join(usage_dir, "usage.jsonl"), ep["provider"], now)
        sources.append({"id": ep["id"], "name": ep["name"], "up": up,
                        "text": "%s - %s today\n%s in 7 days" % ("up" if up else "down", fmt(today), fmt(week))})
    try:
        os.makedirs(usage_dir, exist_ok=True)
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(cache, f)
    except OSError:
        pass
    return {"version": 1, "generated": int(now), "sources": sources}


def main(argv):
    opt = lambda n: argv[argv.index(n) + 1] if n in argv and argv.index(n) + 1 < len(argv) else None
    usage_dir = opt("--dir") or os.environ.get("AGENT_HUB_USAGE_DIR") or os.path.join(home(), "usage")
    config = read_json(opt("--config") or os.path.join(home(), "config.json"))
    sys.stdout.write(json.dumps(build(usage_dir, config)) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
