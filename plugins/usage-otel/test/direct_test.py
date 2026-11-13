import io, json, os, stat, sys, tempfile, unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "bin"))
import agent_hub_direct as dr
import agent_hub_usage as ahu

CLAUDE_JSON = {"type": "result", "result": "ok", "session_id": "11111111-aaaa", "total_cost_usd": 0.5,
               "usage": {"input_tokens": 2, "cache_creation_input_tokens": 10, "cache_read_input_tokens": 7, "output_tokens": 4},
               "modelUsage": {"claude-haiku-5-5": {"inputTokens": 2, "outputTokens": 4}}}
CODEX_EVENTS = [{"type": "thread.started"}, {"type": "turn.completed", "usage": {"input_tokens": 100, "cached_input_tokens": 60, "output_tokens": 9}},
                {"type": "turn.completed", "usage": {"input_tokens": 50, "cached_input_tokens": 0, "output_tokens": 1}}]


def fake(dirname, name, payload_lines):
    """A fake CLI: prints the payload, echoes its argv to stderr-free file args.txt, exits 3."""
    body = os.path.join(dirname, name + ".py")
    with open(body, "w") as f:
        f.write("import sys\nopen(%r,'w').write(' '.join(sys.argv[1:]))\nprint(%r)\nsys.exit(3)\n" % (os.path.join(dirname, name + ".args"), "\n".join(payload_lines)))
    if os.name == "nt":
        exe = os.path.join(dirname, name + ".cmd")
        open(exe, "w").write('@"%s" "%s" %%*\n' % (sys.executable, body))
    else:
        exe = os.path.join(dirname, name)
        open(exe, "w").write('#!/bin/sh\nexec "%s" "%s" "$@"\n' % (sys.executable, body))
        os.chmod(exe, os.stat(exe).st_mode | stat.S_IEXEC)
    return exe


class Direct(unittest.TestCase):
    def run_direct(self, argv, env):
        old = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = dr.main(argv)
        finally:
            for k, v in old.items():
                if v is None: os.environ.pop(k, None)
                else: os.environ[k] = v
        return rc, buf.getvalue()

    def test_claude_and_codex_records_counted_by_usage(self):
        with tempfile.TemporaryDirectory() as t:
            ud = os.path.join(t, "usage")
            cl = fake(t, "fclaude", [json.dumps(CLAUDE_JSON)])
            cx = fake(t, "fcodex", [json.dumps(e) for e in CODEX_EVENTS])
            env = {"AGENT_HUB_USAGE_DIR": ud, "AGENT_HUB_DIRECT_CLAUDE": cl, "AGENT_HUB_DIRECT_CODEX": cx}
            rc, out = self.run_direct(["claude", "--session", "s-test", "--client", "drv", "--", "-p", "hi"], env)
            self.assertEqual(rc, 3)  # exit code passes through
            self.assertEqual(out.strip(), "ok")  # text mode prints only the result
            self.assertIn("--output-format json", open(os.path.join(t, "fclaude.args")).read())
            rc, out = self.run_direct(["codex", "--session", "s-test", "--", "exec", "-"], env)
            self.assertEqual(rc, 3)
            self.assertEqual(len(out.strip().splitlines()), 3)  # JSONL passes through unchanged
            self.assertEqual(open(os.path.join(t, "fcodex.args")).read(), "exec --json -")
            recs = [json.loads(l) for l in open(os.path.join(ud, "usage.jsonl"))]
            self.assertEqual([r["provider"] for r in recs], ["claude-headless", "codex-direct"])
            self.assertTrue(all(r["session"] == "s-test" for r in recs))
            c, x = recs
            self.assertEqual((c["in"], c["out"], c["cached"], c["cost_usd"], c["model"], c["client"]), (12, 4, 7, 0.5, "claude-haiku-5-5", "drv"))
            self.assertEqual((x["in"], x["out"], x["cached"]), (150, 10, 60))
            s = ahu.summarize(os.path.join(ud, "sessions", "s-test.jsonl"))
            self.assertEqual(s["total"]["n"], 2)
            sm = json.load(open(os.path.join(ud, "sessions", "s-test.sum.json")))
            self.assertEqual(sm["total"]["n"], 2)
            self.assertEqual(sm["providers"]["claude-headless"]["cost_usd"], 0.5)

    def test_session_required_and_backfill_sidecar(self):
        rc, _ = self.run_direct(["claude", "--", "-p", "x"], {"AGENT_HUB_SESSION": "", "CLAUDE_CODE_SESSION_ID": ""})
        self.assertEqual(rc, 2)
        with tempfile.TemporaryDirectory() as t:
            rec = {"ts": "2026-11-10T01:00:00.000Z", "agent": "a1", "session": "", "provider": "codex", "in": 5, "out": 1, "cached": 0, "cost_usd": 0, "credits": 0}
            open(os.path.join(t, "usage.jsonl"), "w").write(json.dumps(rec) + "\n")
            open(os.path.join(t, "usage-backfill-x.jsonl"), "w").write(json.dumps({"agent": "a1", "ts": rec["ts"], "session": "sess-bf"}) + "\n")
            out = {"providers": {}, "total": {"in": 0, "out": 0, "cached": 0, "cost_usd": 0.0, "credits": 0.0, "n": 0}}
            ahu.fold(out, ahu.backfilled(t, "sess-bf"))
            self.assertEqual(out["total"]["n"], 1)
            self.assertEqual(ahu.backfilled(t, "other"), [])
            self.assertEqual(open(os.path.join(t, "usage.jsonl")).read(), json.dumps(rec) + "\n")  # never rewritten


if __name__ == "__main__":
    unittest.main()
