import json, os, sys, tempfile, threading, time, unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "bin"))
import agent_hub_widget as w


class Models(BaseHTTPRequestHandler):
    hits = 0

    def do_GET(self):
        Models.hits += 1
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"data":[{"id":"m"}]}')

    def log_message(self, *a):
        pass


class WidgetJson(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.srv = HTTPServer(("127.0.0.1", 0), Models)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.port = self.srv.server_address[1]
        Models.hits = 0
        self.local = {"command": ["node", "x", "http://127.0.0.1:%d/v1" % self.port]}

    def tearDown(self):
        self.srv.shutdown()

    def write(self, name, obj):
        with open(os.path.join(self.d, name), "w", encoding="utf-8") as f:
            f.write(obj if isinstance(obj, str) else json.dumps(obj))

    def test_qoder_from_the_saved_poll_and_qwen_from_probe_and_feed(self):
        now = time.time()
        self.write("qoder-last.json", {"s": {"credits_used": 6251, "credits_remaining": 6457, "reset_time": "2026-11-28T16:00:00+00:00"}, "at": int(now * 1000)})
        day = time.strftime("%Y-%m-%d", time.gmtime(now))
        old = time.strftime("%Y-%m-%d", time.gmtime(now - 3 * 86400))
        feed = [{"ts": day + "T01:00:00Z", "provider": "qwen-code-local", "in": 1000, "out": 500},
                {"ts": old + "T01:00:00Z", "provider": "qwen-code-local-ro", "in": 2000, "out": 0},
                {"ts": old + "T01:00:00Z", "provider": "claude", "in": 9, "out": 9}]
        self.write("usage.jsonl", "\n".join(json.dumps(r) for r in feed) + "\nnot json\n")
        config = {"agents": {"providers": {
            "qwen-code-local": self.local,
            "qwen-code-gone": {"command": ["node", "x", "http://127.0.0.1:1/v1"]},
            "qwen-code-gone-ro": {"command": ["node", "x", "http://127.0.0.1:1/v1"]},
            "claude": {"command": ["claude"]}}}}
        out = w.build(self.d, config, now)
        by = {s["id"]: s for s in out["sources"]}
        self.assertEqual(out["version"], 1)
        self.assertEqual(by["qoder"]["percent"], 49.2)
        self.assertEqual(by["qoder"]["text"], "6.5k credits left\n49% used - resets 28 Nov")
        self.assertEqual(by["qwen_laptop"]["text"], "up - 1.5k today\n3.5k in 7 days")
        self.assertNotIn("percent", by["qwen_laptop"])
        self.assertEqual((by["qwen_laptop"]["tokens_today"], by["qwen_laptop"]["tokens_7d"]), (1500, 3500))
        down = [s for s in out["sources"] if s["id"].startswith("qwen") and not s["up"]]
        self.assertEqual(len(down), 1)  # the -ro twin is folded away
        self.assertTrue(down[0]["text"].startswith("down"))

    def test_every_provider_kind_becomes_a_tile_and_disabled_or_ro_ones_do_not(self):
        now = time.time()
        day = time.strftime("%Y-%m-%d", time.gmtime(now))
        self.write("usage.jsonl", json.dumps({"ts": day + "T01:00:00Z", "provider": "codex", "in": 700, "out": 300}) + "\n"
                   + json.dumps({"ts": day + "T02:00:00Z", "provider": "seen-only", "in": 5, "out": 5}) + "\n")
        config = {"agents": {"providers": {
            "codex": {"models": []},
            "claude-clean": {"extends": "claude", "label": "Claude (clean MCP)", "command": ["claude.cmd"]},
            "opencode": {"enabled": True},
            "copilot": {"enabled": False},
            "qwen-code-10-0-0-9": {"label": "Qwen Code 10.0.0.9", "command": ["node", "x", "http://127.0.0.1:%d/v1" % self.port]},
            "qwen-code-10-0-0-9-ro": {"command": ["node", "x"]},
            "mylocal": {"label": "My llama", "command": ["node", "y", "http://127.0.0.1:%d" % self.port]}}}}
        out = w.build(self.d, config, now)
        by = {s["id"]: s for s in out["sources"]}
        self.assertEqual(set(by), {"codex", "claude_clean", "opencode", "qwen_laptop", "mylocal"})
        self.assertEqual(by["codex"]["kind"], "codex")
        self.assertEqual(by["codex"]["text"], "1.0k today\n1.0k in 7 days")
        self.assertNotIn("up", by["codex"])  # no endpoint: nothing to probe
        self.assertEqual(by["claude_clean"]["name"], "Claude")
        self.assertEqual(by["claude_clean"]["kind"], "claude")
        self.assertTrue(by["mylocal"]["up"])
        self.assertEqual(by["mylocal"]["kind"], "custom")

    def test_label_ip_is_shortened_to_the_last_octet(self):
        config = {"agents": {"providers": {"x": {"label": "Box " + ".".join(["192", "168", "1", "50"]) + " main", "command": ["c"]}}}}
        self.assertEqual(w.build(self.d, config, 1)["sources"][0]["name"], "Box .50 main")

    def test_probe_is_cached_so_repeat_calls_add_no_load(self):
        self.write("usage.jsonl", "")
        config = {"agents": {"providers": {"qwen-code-local": self.local}}}
        now = time.time()
        w.build(self.d, config, now)
        w.build(self.d, config, now + 60)
        self.assertEqual(Models.hits, 1)

    def test_clean_display_names_and_idle_laptop(self):
        model = os.path.join(self.d, "m.gguf")
        open(model, "w").close()
        env = {"LLAMA_SERVER_BIN": model, "LAPTOP_MODEL_PATH": model, "LAPTOP_PORT": "1"}
        config = {"agents": {"providers": {
            "codex": {}, "claude-clean": {"extends": "claude", "label": "Claude (clean MCP)"},
            "opencode": {}, "qoder": {"label": "Qoder (no user MCP)"},
            "mytool": {"label": "my tool (x)"},
            "qwen-code-laptop": {"command": ["node", "x"], "env": env}}}}
        real = w.shutil.which
        w.shutil.which = lambda name: "nvidia-smi"
        try:
            out = {s["id"]: s for s in w.build(self.d, config, 1)["sources"]}
            self.assertEqual([out[i]["name"] for i in ("codex", "claude_clean", "opencode", "qoder")],
                             ["Codex", "Claude", "OpenCode", "Qoder"])
            self.assertEqual(out["mytool"]["name"], "My Tool")
            lap = out["qwen_laptop"]
            self.assertTrue(lap["idle"] and "up" not in lap)
            self.assertTrue(lap["text"].startswith("idle (starts on demand)\n"))
            w.shutil.which = lambda name: None  # no GPU driver: it cannot start, so it is down
            w.os.remove(os.path.join(self.d, "widget-probe.json"))
            lap = {s["id"]: s for s in w.build(self.d, config, 1)["sources"]}["qwen_laptop"]
            self.assertEqual(lap["up"], False)
            self.assertNotIn("idle", lap)
        finally:
            w.shutil.which = real

    def test_nothing_configured_is_an_empty_list_not_an_error(self):
        self.assertEqual(w.build(self.d, {}, 1)["sources"], [])


if __name__ == "__main__":
    unittest.main()
