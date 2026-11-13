// Daemon launch marker (13-11-2026). Runs the Paseo CLI in THIS node process, so the daemon's command line is
// `node scripts/daemon-main.mjs --title=agent-hub-daemon --home <H>`: no "@getpaseo", no " run ".
// The old driver kill filter (node.exe + "@getpaseo" + " run ") that killed the daemon on 11-11 no longer matches it.
// usage: AGENT_HUB_PASEO_ENTRY=<paseo cli dist/index.js> node daemon-main.mjs --title=agent-hub-daemon [--home H]  (argv rewritten to: paseo daemon run --home H)
import { pathToFileURL } from "node:url";
const entry = process.env.AGENT_HUB_PASEO_ENTRY; // path kept out of the command line (it contains the package name)
const rest = process.argv.slice(2).filter((a) => !a.startsWith("--title="));
if (!entry) { console.error("usage: AGENT_HUB_PASEO_ENTRY=<paseo cli dist/index.js> node daemon-main.mjs --title=agent-hub-daemon [--home H]"); process.exit(2); }
process.title = "agent-hub-daemon";
process.argv = [process.argv[0], entry, "daemon", "run", ...rest];
await import(pathToFileURL(entry).href);
