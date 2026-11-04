"""Qoder credits poller: prints one JSON line (or Prometheus text with --prom). Reuses the qodercli login; no secret is read.
Needs `pip install qoder-agent-sdk`. Optional per-day credits: set AGENT_HUB_QCREDITS_CMD to a command printing {"groups": {"YYYY-MM-DD": {"credits": N}}}.
Usage: qoder_poll.py [--prom] [--dev NAME]"""
import asyncio, json, os, shlex, subprocess, sys
from datetime import datetime, timezone


def fetch_usage():
    from qoder_agent_sdk import QoderAgentOptions, QoderSDKClient

    async def go():
        async with QoderSDKClient(QoderAgentOptions(auth={"type": "qodercli"})) as c:
            return await c.get_usage_info()
    return asyncio.run(go()) or {}


def reset_iso(ms):
    if not ms:
        return None
    return datetime.fromtimestamp(ms / 1000 if ms > 1e11 else ms, timezone.utc).isoformat()


def summarize(u, groups=None, today=None):
    org = u.get("orgResourcePackage") or {}
    today = today or datetime.now().strftime("%Y-%m-%d")
    return {
        "userType": u.get("userType"), "totalUsagePercentage": u.get("totalUsagePercentage"),
        "isQuotaExceeded": u.get("isQuotaExceeded"), "reset_time": reset_iso(u.get("expiresAt")),
        "credits_used": org.get("used"), "credits_remaining": org.get("remaining"), "credits_unit": org.get("unit"),
        "credits_used_today": (groups or {}).get(today, {}).get("credits"),
    }


def prom(s, dev):
    lab = 'provider="qoder",dev="%s"' % dev
    return "\n".join('%s{%s} %s' % (k, lab, s[k]) for k in ("credits_used", "credits_remaining", "credits_used_today") if s.get(k) is not None) + "\n"


def main(argv):
    groups = None
    cmd = os.environ.get("AGENT_HUB_QCREDITS_CMD")
    if cmd:
        try:
            groups = json.loads(subprocess.run(shlex.split(cmd), capture_output=True, text=True, timeout=60).stdout)["groups"]
        except Exception:
            groups = None
    s = summarize(fetch_usage(), groups)
    dev = argv[argv.index("--dev") + 1] if "--dev" in argv else os.environ.get("AGENT_HUB_DEV", "")
    sys.stdout.write(prom(s, dev) if "--prom" in argv else json.dumps(s) + "\n")


if __name__ == "__main__":
    main(sys.argv[1:])
