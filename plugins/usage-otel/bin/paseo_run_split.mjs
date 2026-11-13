// `paseo` with create-then-prompt for `agent-hub direct paseo` (the CLI cannot create an agent without a prompt, the daemon client can).
// It patches DaemonClient.createAgent of the installed Paseo CLI: create the agent WITHOUT its prompt, hand the id to the launcher (<handshake>.id), wait until the launcher has written
// the gate marker for that id (<handshake>.go AND <gate>/direct/<id>.json), then send the prompt. Everything else (flags, waiting, output, exit codes) is the CLI's own.
// env: AGENT_HUB_DIRECT_HANDSHAKE (path prefix), AGENT_HUB_GATE_DIR, AGENT_HUB_PASEO_CLI_DIR (default %APPDATA%/npm/node_modules/@getpaseo/cli).
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import os from "node:os";

const cli = process.env.AGENT_HUB_PASEO_CLI_DIR || join(process.env.APPDATA || join(os.homedir(), ".config"), "npm", "node_modules", "@getpaseo", "cli");
const hs = process.env.AGENT_HUB_DIRECT_HANDSHAKE;
const gate = process.env.AGENT_HUB_GATE_DIR || join(process.env.PASEO_HOME || join(os.homedir(), ".paseo"), "gate");
if (!hs) { console.error("paseo_run_split: AGENT_HUB_DIRECT_HANDSHAKE is required"); process.exit(2); }
const { DaemonClient } = await import(pathToFileURL(join(cli, "node_modules", "@getpaseo", "client", "dist", "daemon-client.js")).href);
const orig = DaemonClient.prototype.createAgent;
DaemonClient.prototype.createAgent = async function (options) {
  const { initialPrompt, images, ...rest } = options;
  const agent = await orig.call(this, rest); // no prompt: the agent exists, idle
  writeFileSync(hs + ".id.tmp", agent.id); renameSync(hs + ".id.tmp", hs + ".id");
  const end = Date.now() + Number(process.env.AGENT_HUB_DIRECT_MARKER_WAIT_MS || 30000);
  while (!(existsSync(hs + ".go") && existsSync(join(gate, "direct", agent.id + ".json")))) {
    if (Date.now() > end) throw new Error("agent-hub direct: the gate marker was not written within the wait; the agent " + agent.id + " was created but never prompted");
    await new Promise((r) => setTimeout(r, 50));
  }
  if (initialPrompt) await this.sendAgentMessage(agent.id, initialPrompt, images && images.length ? { images } : {});
  return agent;
};
await import(pathToFileURL(join(cli, "dist", "index.js")).href);
