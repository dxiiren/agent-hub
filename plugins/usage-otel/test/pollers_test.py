import os, sys, unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "pollers"))
import opencode_export as oe
import qoder_poll as qp


class Pollers(unittest.TestCase):
    def test_opencode_totals_and_prom(self):
        s = [{"messages": [
            {"info": {"role": "user"}},
            {"info": {"role": "assistant", "providerID": "office", "modelID": "m", "tokens": {"input": 10, "output": 4, "cache": {"read": 2}}}},
            {"info": {"role": "assistant", "providerID": "office", "modelID": "m", "tokens": {"input": 5, "output": 1}}},
        ]}]
        t = oe.totals(s)
        self.assertEqual(t[("office", "m")], {"input": 15, "output": 5, "cache_read": 2})
        self.assertIn('opencode_tokens_total{provider="office",model="m",type="input",dev="d"} 15', oe.prom(t, "d"))

    def test_qoder_summary(self):
        u = {"userType": "x", "totalUsagePercentage": 0.0, "isQuotaExceeded": False, "expiresAt": 1795000000000,
             "orgResourcePackage": {"used": 4000, "remaining": 2707, "unit": "credits"}}
        s = qp.summarize(u, {"2026-11-04": {"credits": 16.5}}, today="2026-11-04")
        self.assertEqual((s["credits_used"], s["credits_remaining"], s["credits_used_today"]), (4000, 2707, 16.5))
        self.assertTrue(s["reset_time"].startswith("2026-"))
        self.assertIn('credits_remaining{provider="qoder",dev="d"} 2707', qp.prom(s, "d"))


if __name__ == "__main__":
    unittest.main()
