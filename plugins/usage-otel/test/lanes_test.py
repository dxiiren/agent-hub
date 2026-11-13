"""Every direct lane records real tokens on a successful run; a success with none is logged kind=usage-missing. Statusline robustness."""
import io, json, os, subprocess, sys, tempfile, unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "bin"))
import agent_hub_direct as dr
from direct_test import CLAUDE_JSON, CODEX_EVENTS, LIVE_STREAM

STATUSLINE = os.path.join(os.path.expanduser("~"), ".claude", "statusline.py")


def fake_ok(d, name, lines):
    body = os.path.join(d, name + ".py")
    open(body, "w").write("print(%r)\n" % chr(10).join(lines))
    if os.name == "nt":
        exe = os.path.join(d, name + ".cmd")
        open(exe, "w").write('@"%s" "%s" %%*' % (sys.executable, body) + chr(10))
    else:
        exe = os.path.join(d, name)
        open(exe, "w").write("#!/bin/sh" + chr(10) + 'exec "%s" "%s" "$@"' % (sys.executable, body) + chr(10))
        os.chmod(exe, 0o755)
    return exe


class Lanes(unittest.TestCase):
    def run_lane(self, ud, tool, exe, args):
        os.environ.update(AGENT_HUB_USAGE_DIR=ud, **{"AGENT_HUB_DIRECT_" + tool.upper(): exe})
        try:
            with redirect_stdout(io.StringIO()):
                return dr.main([tool, "--session", "lane", "--"] + args)
        finally:
            os.environ.pop("AGENT_HUB_USAGE_DIR"); os.environ.pop("AGENT_HUB_DIRECT_" + tool.upper())

    def test_no_successful_lane_records_zero_tokens(self):
        with tempfile.TemporaryDirectory() as t:
            ud = os.path.join(t, "u")
            runs = [("claude", [json.dumps(CLAUDE_JSON)], ["-p", "x"]),  # plain text: forced to json
                    ("claude", [json.dumps(CLAUDE_JSON)], ["-p", "x", "--output-format", "json"]),
                    ("claude", [json.dumps(e) for e in LIVE_STREAM], ["-p", "x", "--output-format", "stream-json", "--verbose"]),
                    ("codex", [json.dumps(e) for e in CODEX_EVENTS], ["exec", "-"])]
            for i, (tool, lines, args) in enumerate(runs):
                self.assertEqual(self.run_lane(ud, tool, fake_ok(t, "f%d" % i, lines), args), 0)
            recs = [json.loads(l) for l in open(os.path.join(ud, "usage.jsonl"))]
            self.assertEqual(len(recs), 4)
            for r in recs:
                self.assertTrue(r["in"] > 0 and r["out"] > 0, r)
                self.assertNotEqual(r.get("kind"), "usage-missing")

    def test_success_without_usage_is_logged_usage_missing(self):
        with tempfile.TemporaryDirectory() as t:
            ud = os.path.join(t, "u")
            self.assertEqual(self.run_lane(ud, "claude", fake_ok(t, "g", ["plain text, no json"]), ["-p", "x"]), 0)
            r = [json.loads(l) for l in open(os.path.join(ud, "usage.jsonl"))]
            self.assertEqual([x.get("kind") for x in r], ["usage-missing"])


@unittest.skipUnless(os.path.exists(STATUSLINE), "no ~/.claude/statusline.py")
class Statusline(unittest.TestCase):
    def slots(self, setup):
        with tempfile.TemporaryDirectory() as t:
            a = os.path.join(t, ".paseo", "usage", "active")
            os.makedirs(a)
            setup(a)
            code = "import sys;sys.path.insert(0,%r);import statusline as s;print(s.hub_slots())" % os.path.dirname(STATUSLINE)
            env = dict(os.environ, USERPROFILE=t, HOME=t)
            return subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True).stdout.strip()

    def test_headless_counted_apart_and_hidden_at_zero(self):
        def mk(a):
            json.dump({"total": 24}, open(os.path.join(a, "total.json"), "w"))
            for i in range(2):
                json.dump({"provider": "claude-headless", "direct": True}, open(os.path.join(a, "t-%d" % os.getpid()), "w"))
            json.dump({"provider": "codex"}, open(os.path.join(a, "t-%d-1" % os.getpid()), "w"))
        self.assertEqual(self.slots(mk), "1/24 \u00b7 1 headless")
        self.assertEqual(self.slots(lambda a: json.dump({"total": 24}, open(os.path.join(a, "total.json"), "w"))), "0/24")

    def test_missing_total_corrupt_marker_never_crash(self):
        def mk(a):
            open(os.path.join(a, "t-%d" % os.getpid()), "w").write("{not json")
            json.dump({"provider": "x", "direct": True}, open(os.path.join(a, "t-%d-2" % os.getpid()), "w"))
        out = self.slots(mk)  # no total.json at all
        self.assertIn("1 headless", out)
        self.assertEqual(self.slots(lambda a: open(os.path.join(a, "total.json"), "w").write("garbage")), "None")


if __name__ == "__main__":
    unittest.main()
