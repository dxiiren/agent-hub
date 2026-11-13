import io, json, os, stat, sys, tempfile, unittest, unittest.mock
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

    def test_parent_session_view_and_slot_marker_and_env_marker(self):
        """status line: the launching Claude session sees the row (per-session view only), a t-<pid> marker lives during the run, the child carries the backstop marker"""
        with tempfile.TemporaryDirectory() as t:
            ud = os.path.join(t, "usage")
            body = os.path.join(t, "probe.py")
            with open(body, "w") as f:
                f.write("import os,sys,json\nd=os.path.join(%r,'active')\n"
                        "open(%r,'w').write(json.dumps({'active':sorted(os.listdir(d)) if os.path.isdir(d) else [],"
                        "'sid':os.environ.get('AGENT_HUB_DIRECT_SESSION'),'wpid':os.environ.get('AGENT_HUB_DIRECT_PID')}))\n"
                        "print(%r)\n" % (ud, os.path.join(t, "probe.out"), json.dumps(CLAUDE_JSON)))
            if os.name == "nt":
                exe = os.path.join(t, "probe.cmd"); open(exe, "w").write('@"%s" "%s" %%*\n' % (sys.executable, body))
            else:
                exe = os.path.join(t, "probe"); open(exe, "w").write('#!/bin/sh\nexec "%s" "%s" "$@"\n' % (sys.executable, body)); os.chmod(exe, 0o755)
            env = {"AGENT_HUB_USAGE_DIR": ud, "AGENT_HUB_DIRECT_CLAUDE": exe, "CLAUDE_CODE_SESSION_ID": "parent-claude-sess"}
            rc, _ = self.run_direct(["claude", "--session", "w3-xyz", "--", "-p", "hi"], env)
            seen = json.load(open(os.path.join(t, "probe.out")))
            self.assertIn("t-%d" % os.getpid(), seen["active"])  # slot marker present while the child ran
            self.assertEqual((seen["sid"], seen["wpid"]), ("w3-xyz", str(os.getpid())))
            self.assertEqual(os.listdir(os.path.join(ud, "active")), [])  # and gone after
            self.assertEqual(len(open(os.path.join(ud, "usage.jsonl")).read().splitlines()), 1)  # global log single-counted
            for sid in ("w3-xyz", "parent-claude-sess"):
                sm = json.load(open(os.path.join(ud, "sessions", sid + ".sum.json")))
                self.assertEqual(sm["providers"]["claude-headless"]["n"], 1)
                self.assertEqual(ahu.summarize(os.path.join(ud, "sessions", sid + ".jsonl"))["total"]["n"], 1)
            # same id (no --session): counted once, not twice
            rc, _ = self.run_direct(["claude", "--", "-p", "hi"], dict(env, CLAUDE_CODE_SESSION_ID="same", AGENT_HUB_SESSION="same"))
            self.assertEqual(json.load(open(os.path.join(ud, "sessions", "same.sum.json")))["total"]["n"], 1)

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


# Captured from live runs 13-11-2026 (claude 2.x, haiku, "say ok"); trimmed to the fields the parser reads.
LIVE_JSON = {"type": "result", "subtype": "success", "is_error": False, "result": "ok", "session_id": "6e4490c0-4492-4919-9306-92b355c28413",
             "total_cost_usd": 0.014839200000000002,
             "usage": {"input_tokens": 2, "cache_creation_input_tokens": 74185, "cache_read_input_tokens": 0, "output_tokens": 4},
             "modelUsage": {"claude-haiku-5-5": {"inputTokens": 2, "outputTokens": 4, "cacheReadInputTokens": 0, "cacheCreationInputTokens": 74185, "costUSD": 0.0148392}}}
LIVE_STREAM = [{"type": "system", "subtype": "init", "session_id": "x"}, {"type": "assistant", "message": {"content": [{"type": "text", "text": "ok"}]}},
               dict(LIVE_JSON, usage={"input_tokens": 2, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 74185, "output_tokens": 4})]


class ParseTest(unittest.TestCase):
    def test_claude_json_records_in_out_cached_cost(self):
        p = dr.parse_claude(json.dumps(LIVE_JSON))
        self.assertEqual((p[2], p[3], p[4], p[5]), (74187, 4, 0, 0.014839200000000002))
        self.assertEqual(p[1], "claude-haiku-5-5")

    def test_claude_stream_json_uses_result_event(self):
        p = dr.parse_claude(chr(10).join(json.dumps(e) for e in LIVE_STREAM))
        self.assertEqual((p[2], p[3], p[4]), (2, 4, 74185))

    def test_claude_no_result_event_is_none(self):
        self.assertIsNone(dr.parse_claude(json.dumps(LIVE_STREAM[0])))

    def test_marker_heartbeat_moves_mtime_and_is_removed_on_exit(self):
        import threading, time
        with tempfile.TemporaryDirectory() as t:
            body = os.path.join(t, "slow.py")
            open(body, "w").write("import time;time.sleep(2.5);print(1)")
            exe = os.path.join(t, "slow.cmd" if os.name == "nt" else "slow")
            open(exe, "w").write(('@"%s" "%s" %%*' + chr(10) if os.name == "nt" else '#!/bin/sh' + chr(10) + 'exec "%s" "%s" "$@"' + chr(10)) % (sys.executable, body))
            os.chmod(exe, 0o755)
            os.environ.update(AGENT_HUB_DIRECT_CODEX=exe, AGENT_HUB_HEARTBEAT_S="0.3", PASEO_HOME=t)
            marker = os.path.join(t, "usage", "active", "t-%d" % os.getpid())
            seen = []
            def watch():
                time.sleep(0.5)
                for _ in range(6):
                    try: seen.append(os.path.getmtime(marker))
                    except OSError: pass
                    time.sleep(0.3)
            th = threading.Thread(target=watch); th.start()
            try:
                with redirect_stdout(io.StringIO()):
                    dr.main(["codex", "--session", "s-hb", "--", "exec", "x"])
            finally:
                th.join()
                for k in ("AGENT_HUB_DIRECT_CODEX", "AGENT_HUB_HEARTBEAT_S", "PASEO_HOME"): os.environ.pop(k, None)
            self.assertGreater(len(set(seen)), 1, seen)
            self.assertFalse(os.path.exists(marker))

    def _paseo(self, t, ok):
        """Run `direct paseo` against a fake paseo (exit 0 when ok, else 3) with a private gate store; returns (args, gate dir)."""
        fake(t, "paseo", ["ok"])
        exe = os.path.join(t, "paseo" + (".cmd" if os.name == "nt" else ""))
        if ok:
            body = os.path.join(t, "paseo.py"); src = open(body).read().replace("sys.exit(3)", "sys.exit(0)"); open(body, "w").write(src)
        gate = os.path.join(t, "gate")
        if "AGENT_HUB_DIRECT_PASEO_LS" not in os.environ:  # the agent lookup must not hit the fake that records the run's args
            lsb = os.path.join(t, "nols.py"); open(lsb, "w").write("print('[]')" + chr(10))
            lse = os.path.join(t, "nols.cmd" if os.name == "nt" else "nols")
            open(lse, "w").write(('@"%s" "%s" %%*' % (sys.executable, lsb) + chr(10)) if os.name == "nt" else ('#!/bin/sh' + chr(10) + 'exec "%s" "%s" "$@"' % (sys.executable, lsb) + chr(10)))
            if os.name != "nt": os.chmod(lse, os.stat(lse).st_mode | stat.S_IEXEC)
            os.environ["AGENT_HUB_DIRECT_PASEO_LS"] = lse; own_ls = True
        else:
            own_ls = False
        os.environ["AGENT_HUB_DIRECT_PASEO"] = exe; os.environ["AGENT_HUB_GATE_DIR"] = gate
        try:
            with redirect_stdout(io.StringIO()):
                dr.main(["paseo", "--session", "s-lab", "--", "run", "--cwd", t, "--provider", "codex", "hi"])
        finally:
            del os.environ["AGENT_HUB_DIRECT_PASEO"]; del os.environ["AGENT_HUB_GATE_DIR"]
            if own_ls: del os.environ["AGENT_HUB_DIRECT_PASEO_LS"]
        return open(os.path.join(t, "paseo.args")).read(), gate

    def test_paseo_run_gets_session_labels_and_a_matching_gate_nonce(self):
        with tempfile.TemporaryDirectory() as t:
            args, gate = self._paseo(t, ok=True)
            self.assertIn("session=s-lab", args); self.assertIn("run --label", args)
            nonce = args.split("direct-nonce=")[1].split()[0]
            self.assertRegex(nonce, r"^[0-9a-f]{32}$")
            # the gate plugin's store holds exactly that single-use nonce (the plugin never trusts a label alone)
            self.assertEqual(os.listdir(os.path.join(gate, "direct")), [nonce + ".json"])
            self.assertFalse(os.path.exists(os.path.join(gate, "requests")), "a direct marker never writes into the route request store")

    def test_marker_is_bound_to_the_agent_id_found_by_the_label(self):
        with tempfile.TemporaryDirectory() as t:
            ls = os.path.join(t, "ls.py"); open(ls, "w").write("import json" + chr(10) + "print(json.dumps([{'id': 'LATE-COPY', 'createdAt': '2026-01-02'}, {'id': 'REAL-AGENT', 'createdAt': '2026-01-01'}]))" + chr(10))
            exe = os.path.join(t, "ls.cmd" if os.name == "nt" else "ls")
            open(exe, "w").write(('@"%s" "%s" %%*' % (sys.executable, ls) + chr(10)) if os.name == "nt" else ('#!/bin/sh' + chr(10) + 'exec "%s" "%s" "$@"' % (sys.executable, ls) + chr(10)))
            if os.name != "nt": os.chmod(exe, os.stat(exe).st_mode | stat.S_IEXEC)
            os.environ["AGENT_HUB_DIRECT_PASEO_LS"] = exe
            try:
                args, gate = self._paseo(t, ok=True)
            finally:
                del os.environ["AGENT_HUB_DIRECT_PASEO_LS"]
            f = os.path.join(gate, "direct", args.split("direct-nonce=")[1].split()[0] + ".json")
            self.assertEqual(json.load(open(f)).get("agentId"), "REAL-AGENT", "earliest-created agent with the label wins; a later copy is never bound")

    def test_ambiguous_lookup_without_creation_times_binds_nothing(self):
        with unittest.mock.patch.object(dr.subprocess, "run", return_value=unittest.mock.Mock(stdout='[{"id": "A"}, {"id": "B"}]')):
            self.assertIsNone(dr.find_agent_id(["x"], "a" * 32))
        with unittest.mock.patch.object(dr.subprocess, "run", return_value=unittest.mock.Mock(stdout='[{"id": "A"}]')):
            self.assertEqual(dr.find_agent_id(["x"], "a" * 32), "A")

    def test_failed_paseo_run_leaves_no_marker(self):
        with tempfile.TemporaryDirectory() as t:
            args, gate = self._paseo(t, ok=False)
            self.assertIn("direct-nonce=", args)
            self.assertEqual(os.listdir(os.path.join(gate, "direct")), [], "the run failed: its marker is removed")

    def test_marker_never_overwrites_and_leaves_route_requests_alone(self):
        with tempfile.TemporaryDirectory() as t:
            os.environ["AGENT_HUB_GATE_DIR"] = os.path.join(t, "gate")
            try:
                os.makedirs(os.path.join(t, "gate", "requests")); req = os.path.join(t, "gate", "requests", "abc.json")
                open(req, "w").write('{"cmd": "npm test"}')
                dr.write_direct_marker("d" * 32)
                with self.assertRaises(FileExistsError): dr.write_direct_marker("d" * 32)
                self.assertEqual(open(req).read(), '{"cmd": "npm test"}')
            finally:
                del os.environ["AGENT_HUB_GATE_DIR"]



if __name__ == "__main__":
    unittest.main()
