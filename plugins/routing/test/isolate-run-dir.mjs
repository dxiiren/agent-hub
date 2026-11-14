// A unit test must never read the developer's live run dir (limits.json holds a real "codex usage limit until ..." that made 9 route tests fail on a developer box and pass in the hermetic test-all run). Import this first.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.AGENT_HUB_RUN_DIR = mkdtempSync(join(tmpdir(), "route-test-run-"));
