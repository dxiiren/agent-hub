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
        self.assertEqual(by["qoder"]["text"], "49.2% - resets 28 Nov\n6.3k used - 6.5k left")
        self.assertEqual(by["qwen_laptop"]["text"], "up - 1.5k today\n3.5k in 7 days")
        self.assertNotIn("percent", by["qwen_laptop"])
        down = [s for s in out["sources"] if s["id"].startswith("qwen") and not s["up"]]
        self.assertEqual(len(down), 1)  # the -ro twin is folded away
        self.assertTrue(down[0]["text"].startswith("down"))

    def test_probe_is_cached_so_repeat_calls_add_no_load(self):
        self.write("usage.jsonl", "")
        config = {"agents": {"providers": {"qwen-code-local": self.local}}}
        now = time.time()
        w.build(self.d, config, now)
        w.build(self.d, config, now + 60)
        self.assertEqual(Models.hits, 1)

    def test_nothing_configured_is_an_empty_list_not_an_error(self):
        self.assertEqual(w.build(self.d, {}, 1)["sources"], [])


if __name__ == "__main__":
    unittest.main()
