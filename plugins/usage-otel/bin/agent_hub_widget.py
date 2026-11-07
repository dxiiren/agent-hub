"""Usage summary for desktop widgets: one JSON document on stdout, read-only, stdlib only.

    python agent_hub_widget.py [--dir D] [--config F]

Every provider in the hub config (not disabled, no -ro twin) becomes one source, whatever its kind
(qwen-code, local llama, qoder, codex, claude, opencode, custom), so a provider added in the hub shows up
with no widget change.
Qoder: the last quota the hub already polled (usage/qoder-last.json); this command never polls Qoder.
A provider with an HTTP endpoint: up/down from GET <base>/v1/models (cached on disk, default 300 s, so a
widget that asks every few minutes adds no load). All: tokens today (UTC day) and over the last 7 days from
usage.jsonl. No percentage is invented for providers that have no plan quota.

Output: {"version":1,"generated":<unix>,"sources":[{"id","name","kind","text"(two lines, \n),"percent"?,"up"?}]}
"""
import json, os, re, shutil, sys, time, urllib.request
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


def host_tag(base):
    host = re.sub(r"^https?://", "", base).split("/")[0].split(":")[0]
    if re.match(r"^\d+\.\d+\.\d+\.\d+$", host) and host != "127.0.0.1":
        return host.split(".")[-1]
    if host in ("127.0.0.1", "localhost", "::1"):
        return "laptop"
    return host.split(".")[0]


def safe_id(name):
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def kind_of(name, p):
    text = " ".join([name, str(p.get("extends") or "")] + [str(a) for a in (p.get("command") or [])]).lower()
    for kind in ("qoder", "qwen", "codex", "claude", "opencode"):
        if kind in text:
            return kind
    return "custom"


# Clean tile names for the kinds the hub knows; a "custom" provider keeps its own label.
KIND_NAMES = {"qoder": "Qoder", "codex": "Codex", "claude": "Claude", "opencode": "OpenCode"}


def display_name(name, p, kind):
    if kind in KIND_NAMES:
        return KIND_NAMES[kind]
    label = re.sub(r"\s*\(.*?\)", "", str(p.get("label") or name)).strip()
    label = re.sub(r"\b\d+\.\d+\.\d+\.(\d+)\b", r".\1", label)
    return label if label != label.lower() else label.title()


def can_start(p):
    """The hub starts the laptop server on demand: it can when the binary and the model file exist and a GPU driver is there."""
    env = p.get("env") or {}
    paths = [env.get("LLAMA_SERVER_BIN"), env.get("LAPTOP_MODEL_PATH")]
    return all(paths) and all(os.path.exists(x) for x in paths) and shutil.which("nvidia-smi") is not None


def providers(config):
    """Every provider the hub config lists (not disabled, no -ro twin), whatever its kind."""
    out = []
    for name, p in (config.get("agents", {}).get("providers", {}) or {}).items():
        if name.endswith("-ro") or p.get("enabled") is False:
            continue
        cmd = [str(a) for a in (p.get("command") or [])]
        base = next((a for a in cmd if re.match(r"^https?://", a, re.I)), None)
        port = (p.get("env") or {}).get("LAPTOP_PORT")
        if not base and port:
            base = "http://127.0.0.1:%s/v1" % port
        kind = kind_of(name, p)
        if kind == "qwen" and base:  # keep the short ids/names the first version used
            tag = host_tag(base)
            pid, label = "qwen_" + safe_id(tag), "Qwen " + (("." + tag) if tag.isdigit() else tag)
        else:
            pid = safe_id(name)
            label = display_name(name, p, kind)
        out.append({"provider": name, "id": pid, "name": label, "kind": kind, "base": base,
                    "key": (p.get("env") or {}).get("HUB_OPENAI_API_KEY"), "startable": can_start(p)})
    seen = {}
    for ep in out:  # two providers on one id keep distinct ids and names
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
        q["kind"] = "qoder"
        sources.append(q)
    cache_path = os.path.join(usage_dir, "widget-probe.json")
    cache = read_json(cache_path)
    ttl = float(os.environ.get("AGENT_HUB_WIDGET_PROBE_TTL", "300"))
    feed = os.path.join(usage_dir, "usage.jsonl")
    listed = providers(config)
    ids = {s["id"] for s in sources}
    for ep in listed:
        if ep["kind"] == "qoder" and q:
            continue  # the saved quota already is this provider's tile
        today, week = tally(feed, ep["provider"], now)
        text = "%s today\n%s in 7 days" % (fmt(today), fmt(week))
        src = {"id": ep["id"], "name": ep["name"], "kind": ep["kind"], "text": text,
               "tokens_today": today, "tokens_7d": week}  # numbers: the widget sums a kind's providers into one tile
        if ep["base"]:
            up = probe(ep, cache, now, ttl)
            if not up and ep["startable"]:
                # started on demand, stopped after 15 min idle: not running is not down
                src["idle"] = True
                src["text"] = "idle (starts on demand)\n%s today - %s in 7d" % (fmt(today), fmt(week))
            else:
                src["up"] = up
                src["text"] = "%s - %s" % ("up" if up else "down", text)
        while src["id"] in ids:
            src["id"] += "_2"
        ids.add(src["id"])
        sources.append(src)
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
