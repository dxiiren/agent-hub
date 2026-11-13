import datetime as dt, os, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import usage_backfill_w3 as m

LOG = """10:00:00 b001 v01 df try1 ok=True a b 60s
10:05:00 b001 v02 sn try1 ok=False stub yaml invalid
not a pass line
10:06:00 b001 v03 q122 try2 ok=False x 30s
"""


class T(unittest.TestCase):
    def test_parse_and_match(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "drive-web.log"), "w").write(LOG)
            ps = m.read_passes(d, 0)
            self.assertEqual([(p["fam"], p["ok"], p["secs"]) for p in ps], [("df", True, 60), ("sn", False, None), ("q122", False, 30)])
            t = ps[0]["t_end"]
            mk = lambda ag, off, model="dfmodel", prov="qoder": {"agent": ag, "ts": "x", "provider": prov, "model": model, "_t": t + dt.timedelta(seconds=off)}
            rows = [mk("far", 90), mk("near", 5), mk("wrongmodel", 0, "efficient")]
            used = set()
            self.assertEqual(m.match_row(rows, used, ps[0])["agent"], "near")
            used.add(id(rows[1]))
            self.assertEqual(m.match_row(rows, used, ps[0])["agent"], "far")  # one record never serves two passes
            self.assertIsNone(m.match_row([mk("o", 0, prov="codex")], set(), ps[0]))


if __name__ == "__main__":
    unittest.main()
