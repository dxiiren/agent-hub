"""Backfill the W3 api-docs work (drive-*.log of a reviewdrive-style driver) into a SIDECAR usage file.
usage.jsonl is never rewritten; `agent-hub usage --session <label>` merges <usage dir>/usage-backfill-*.jsonl.
Two line kinds:  tag   {"agent","ts","session"}      -> an existing no-session record of usage.jsonl gets the session
                 synth {"ts","provider",...,"session","backfill":true,"estimated":bool} -> a run that was never recorded (claude -p, codex exec)
Usage: python usage_backfill_w3.py --logs <dir with drive-*.log + sonnet-cost.log> --label w3-api-docs --out <sidecar> [--tz 8] [--dry]
Undo: delete the sidecar file."""
import argparse, collections, datetime as dt, glob, json, os, re, statistics, sys

PASS = re.compile(r'^(\d\d):(\d\d):(\d\d) (b\d+) ([pvf]\d+) (\w+) try(\d+) ok=(True|False)(.*)$')
SECS = re.compile(r' (\d+)s\s*$')
FAM = {"sn": ("claude-headless", "claude-sonnet"), "cx": ("codex-direct", "codex"), "df": ("qoder", "qoder-dfmodel"), "qf": ("qoder", "qoder-qfmodel"),
       "ef": ("qoder", "qoder-efficient"), "q4": ("qoder", "qoder-qmodel_latest"), "q122": ("qwen-code-192-168-1-122", "qwen-122"), "q110": ("qwen-code-192-168-1-110", "qwen-110")}


def read_passes(logs, tz):
    out = []
    for f in sorted(glob.glob(os.path.join(logs, "drive-*.log"))):
        end = dt.datetime.fromtimestamp(os.path.getmtime(f))  # local time of the last write anchors the dates
        rows = []
        for ln in open(f, encoding="utf-8", errors="replace"):
            m = PASS.match(ln.rstrip())
            if m:
                rows.append(m)
        day, prev, days = 0, None, []
        for m in rows:
            s = int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3])
            if prev is not None and s < prev - 3600:
                day += 1
            prev = max(prev or 0, s) if prev is not None and s >= prev - 3600 else s
            days.append(day)
        last = days[-1] if days else 0
        for m, d in zip(rows, days):
            base = dt.datetime.combine(end.date(), dt.time(int(m[1]), int(m[2]), int(m[3]))) - dt.timedelta(days=last - d)
            utc = base - dt.timedelta(hours=tz)
            out.append({"fam": m[6], "ok": m[8] == "True", "secs": int(SECS.search(m[9]).group(1)) if SECS.search(m[9]) else None, "batch": m[4], "spec": os.path.basename(f)[6:-4], "t_end": utc, "kind": m[5][0]})
    return out


def sonnet_costs(logs):
    c = {}
    p = os.path.join(logs, "sonnet-cost.log")
    for ln in open(p, encoding="utf-8", errors="replace") if os.path.exists(p) else []:
        m = re.match(r'^(\d\d:\d\d:\d\d) (\S+) (b\d+) (\w+) cost=([0-9.e-]+)', ln)
        if m:
            c.setdefault((m[2], m[3]), []).append((m[1], float(m[5])))
    return c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--logs", required=True); ap.add_argument("--label", default="w3-api-docs"); ap.add_argument("--out", required=True)
    ap.add_argument("--usage", default=os.path.join(os.path.expanduser("~"), ".paseo", "usage", "usage.jsonl")); ap.add_argument("--tz", type=float, default=8)
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    passes = read_passes(a.logs, a.tz)
    costs = sonnet_costs(a.logs)
    known = [v for vs in costs.values() for _, v in vs]
    mean = statistics.mean(known) if known else 0.0
    # 1. synth records for claude -p and codex exec (never in usage.jsonl)
    lines, est = [], 0
    for p in passes:
        if p["fam"] not in ("sn", "cx"):
            continue
        prov, model = FAM[p["fam"]]
        cost, estimated = 0.0, False
        if p["fam"] == "sn":
            hit = costs.get((p["spec"], p["batch"]))
            if hit:
                cost = hit.pop(0)[1]
            else:
                cost, estimated = mean, True; est += 1
        lines.append({"ts": p["t_end"].strftime("%Y-%m-%dT%H:%M:%S.000Z"), "agent": "bf-%s-%s-%s" % (p["spec"], p["batch"], p["t_end"].strftime("%H%M%S")), "session": a.label,
                      "provider": prov, "model": model, "dev": "backfill", "client": "reviewdrive", "task": "api-docs-" + p["kind"], "in": 0, "out": 0, "cached": 0,
                      "cost_usd": round(cost, 6), "credits": 0.0, "backfill": True, "estimated": estimated or p["fam"] == "cx", "ok": p["ok"], "secs": p["secs"]})
    # 2. tag existing no-session usage.jsonl records that fall inside a hub-family pass window
    win = collections.defaultdict(list)
    for p in passes:
        if p["fam"] in ("sn", "cx") or p["secs"] is None:
            continue
        win[FAM[p["fam"]][0]].append((p["t_end"] - dt.timedelta(seconds=p["secs"] + 60), p["t_end"] + dt.timedelta(seconds=60)))
    tagged, scanned, nosess = 0, 0, 0
    for ln in open(a.usage, encoding="utf-8"):
        try:
            r = json.loads(ln)
        except ValueError:
            continue
        scanned += 1
        if r.get("session"):
            continue
        nosess += 1
        ws = win.get(r.get("provider"))
        if not ws:
            continue
        t = dt.datetime.strptime(r["ts"][:19], "%Y-%m-%dT%H:%M:%S")
        if any(lo <= t <= hi for lo, hi in ws):
            lines.append({"agent": r["agent"], "ts": r["ts"], "session": a.label}); tagged += 1
    agg = collections.defaultdict(lambda: [0, 0, 0])
    for p in passes:
        g = agg[p["fam"]]; g[0] += 1; g[1] += p["ok"]; g[2] += p["secs"] or 0
    rep = {"passes": {k: {"passes": v[0], "ok": v[1], "ok_pct": round(100 * v[1] / v[0], 1), "hours": round(v[2] / 3600, 1)} for k, v in sorted(agg.items())},
           "sonnet_cost_known_n": len(known), "sonnet_cost_mean": round(mean, 4), "sonnet_estimated_passes": est, "synth_records": sum(1 for l in lines if l.get("backfill")),
           "tagged_existing": tagged, "usage_records": scanned, "usage_no_session": nosess}
    if not a.dry:
        with open(a.out, "w", encoding="utf-8") as f:
            for l in lines:
                f.write(json.dumps(l, separators=(",", ":")) + "\n")
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
