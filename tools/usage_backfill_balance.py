"""Make `agent-hub usage --session <label>` show exactly the drive-log pass count for every hub provider.
A pass that left no usage.jsonl record (or one the window tagging could not match: retries, overlapping windows) is added as an estimated zero-token synth line to the SAME sidecar.
Idempotent: the deficit is recomputed from the live `usage --session` view, so a rerun adds nothing. usage.jsonl is never rewritten. Undo: delete the lines with "balance": true.
Usage: python usage_backfill_balance.py --logs <dir with drive-*.log> --label w3-api-docs --out <sidecar> [--dry]"""
import argparse, collections, datetime as dt, json, shutil, subprocess, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from usage_backfill_w3 import read_passes, FAM


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--logs", required=True); ap.add_argument("--label", default="w3-api-docs"); ap.add_argument("--out", required=True); ap.add_argument("--tz", type=float, default=8); ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    cur = json.loads(subprocess.run([shutil.which("agent-hub") or "agent-hub", "usage", "--session", a.label, "--json"], capture_output=True, text=True, check=True).stdout)["providers"]
    by = collections.defaultdict(list)
    for p in read_passes(a.logs, a.tz):
        if p["fam"] not in ("sn", "cx"): by[FAM[p["fam"]][0]].append(p)
    lines, rep = [], {}
    for prov, ps in sorted(by.items()):
        want, have = len(ps), cur.get(prov, {}).get("n", 0); miss = max(0, want - have)
        rep[prov] = {"drive_log_passes": want, "shown_before": have, "added": miss}
        for i, p in enumerate(sorted(ps, key=lambda x: x["t_end"])[-miss:] if miss else []):
            lines.append({"ts": p["t_end"].strftime("%Y-%m-%dT%H:%M:%S.000Z"), "agent": "bal-%s-%s-%s-%d" % (p["spec"], p["batch"], p["t_end"].strftime("%H%M%S"), i), "session": a.label, "provider": prov, "model": FAM[p["fam"]][1],
                          "dev": "backfill", "client": "reviewdrive", "task": "api-docs-" + p["kind"], "in": 0, "out": 0, "cached": 0, "cost_usd": 0, "credits": 0.0, "backfill": True, "balance": True, "estimated": True, "ok": p["ok"], "secs": p["secs"]})
    if lines and not a.dry:
        with open(a.out, "a", encoding="utf-8") as f:
            for l in lines: f.write(json.dumps(l, separators=(",", ":")) + "\n")
    print(json.dumps(rep))


if __name__ == "__main__": main()
