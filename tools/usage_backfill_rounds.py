"""Backfill the round logs of the W3 route drivers (hubdrive*.log, nbq_drive*.log, hub_driver.log) into the SAME sidecar as usage_backfill_w3.py.
usage.jsonl is never rewritten. Existing no-session records inside a driver call window get a tag line; a bare direct launch with no usage record
(hubdrive line rc=0 and used= empty) gets a synthetic `paseo-direct` line (tokens unknown, estimated). Lines already in the sidecar are skipped, so a rerun adds nothing.
Usage: python usage_backfill_rounds.py --logs <dir> [--logs <dir> ...] --label w3-api-docs --out <sidecar> [--usage F] [--tz 8] [--dry]   Undo: delete the sidecar."""
import argparse, collections, datetime as dt, glob, json, os, re, sys

HUB = re.compile(r'^(\d\d):(\d\d):(\d\d) (\S+) try(\d+) rc=(-?\d+) (\d+)s used=(\S*)')
SE = re.compile(r'^(\d\d):(\d\d):(\d\d) (START|END) (b\d+)')


def stamps(path, tz):
    """[(line, datetime UTC naive)] with dates reconstructed backwards from the file mtime (a drop in the clock = midnight passed)."""
    rows = [(l.rstrip("\n"), tuple(int(x) for x in l[:8].split(":"))) for l in open(path, encoding="utf-8", errors="replace") if re.match(r"^\d\d:\d\d:\d\d ", l)]
    day = dt.datetime.fromtimestamp(os.path.getmtime(path)).date(); out = []; nxt = None
    for l, (h, m, s) in reversed(rows):
        sec = h * 3600 + m * 60 + s
        if nxt is not None and sec > nxt: day -= dt.timedelta(days=1)
        nxt = sec
        out.append((l, dt.datetime.combine(day, dt.time(h, m, s)) - dt.timedelta(hours=tz)))
    return out[::-1]


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--logs", action="append", required=True); ap.add_argument("--label", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--usage", default=os.path.expanduser("~/.paseo/usage/usage.jsonl")); ap.add_argument("--tz", type=int, default=8); ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    wins, synth, nlog = [], [], 0
    for d in a.logs:
        for f in sorted(glob.glob(os.path.join(d, "hubdrive*.log")) + glob.glob(os.path.join(d, "nbq_drive*.log")) + glob.glob(os.path.join(d, "hub_driver.log"))):
            nlog += 1; open_ = {}
            for l, t in stamps(f, a.tz):
                m = HUB.match(l)
                if m:
                    secs = int(m.group(7)); wins.append((t - dt.timedelta(seconds=secs + 60), t + dt.timedelta(seconds=60)))
                    if m.group(6) == "0" and m.group(8) == "":
                        synth.append({"ts": t.strftime("%Y-%m-%dT%H:%M:%S.000Z"), "agent": f"br-{os.path.basename(f)[:-4]}-{m.group(4)}-{t:%H%M%S}"[:60], "session": a.label, "provider": "paseo-direct", "model": "unknown", "dev": "backfill", "client": "hubdrive", "task": "api-docs-p", "in": 0, "out": 0, "cached": 0, "cost_usd": 0, "credits": 0.0, "backfill": True, "estimated": True, "ok": True, "secs": secs})
                    continue
                m = SE.match(l)
                if m:
                    if m.group(4) == "START": open_[m.group(5)] = t
                    elif m.group(5) in open_: wins.append((open_.pop(m.group(5)) - dt.timedelta(seconds=30), t + dt.timedelta(seconds=60)))
    have = set()
    if os.path.exists(a.out):
        for ln in open(a.out, encoding="utf-8"):
            try: j = json.loads(ln)
            except ValueError: continue
            have.add((j.get("agent"), j.get("ts")))
    lines, tagged, nosess = [], 0, 0
    for ln in open(a.usage, encoding="utf-8"):
        try: r = json.loads(ln)
        except ValueError: continue
        if r.get("session") or (r.get("agent"), r.get("ts")) in have: continue
        nosess += 1
        t = dt.datetime.strptime(r["ts"][:19], "%Y-%m-%dT%H:%M:%S")
        if any(lo <= t <= hi for lo, hi in wins): lines.append({"agent": r["agent"], "ts": r["ts"], "session": a.label}); tagged += 1
    new_synth = [s for s in synth if (s["agent"], s["ts"]) not in have]
    rep = {"logs": nlog, "windows": len(wins), "tagged_new": tagged, "synth_new": len(new_synth), "synth_by_provider": dict(collections.Counter(s["provider"] for s in new_synth)), "usage_no_session_left": nosess - tagged}
    if not a.dry:
        with open(a.out, "a", encoding="utf-8") as o:
            for x in lines + new_synth: o.write(json.dumps(x) + "\n")
    print(json.dumps(rep))


if __name__ == "__main__": main()
