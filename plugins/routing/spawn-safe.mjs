// Launch a command without a shell. On Windows an npm .cmd/.bat shim is resolved to `node <entry.js>` (read from the shim itself),
// so no argument or config value ever reaches cmd.exe. A shim that cannot be resolved is refused, never run through a shell.
import { readFileSync, existsSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const SHIM = /\.(cmd|bat)$/i;
const BS = String.fromCharCode(92);
// global npm shim last line:  "%_prog%" [node flags] "%dp0%\<entry>" %*
const ENTRY = /"%_prog%"\s+((?:--?[\w.=-]+\s+)*)"%dp0%\\([^"%]+)"\s+%\*/;

/** Windows: a bare name (no folder, no extension) is looked up on PATH as .exe, .cmd, .bat (what cmd.exe would find). */
function findOnPath(name, env) {
  for (const d of String(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean))
    for (const x of [".exe", ".cmd", ".bat"]) { const f = join(d, name + x); if (existsSync(f)) return f; }
  return name;
}

/** -> { cmd, args } to hand to spawn/spawnSync with shell:false. Throws on a shim that cannot be resolved. */
export function resolveCommand(bin, args = [], platform = process.platform, env = process.env) {
  if (platform !== "win32") return { cmd: bin, args };
  if (!/[\\/]/.test(bin) && !/\.[A-Za-z0-9]+$/.test(bin)) bin = findOnPath(bin, env);
  if (!SHIM.test(bin)) return { cmd: bin, args };
  let text = "";
  try { text = readFileSync(bin, "utf8"); } catch (e) { throw new Error(`cannot read command shim ${bin}: ${e.code ?? e.message}`); }
  let flags = [], entry = "";
  const m = ENTRY.exec(text);
  if (m) { flags = m[1].split(/\s+/).filter(Boolean); entry = resolve(dirname(bin), m[2].split(BS).join("/")); }
  else if (text.includes("NPM_CLI_JS")) entry = join(dirname(bin), "node_modules", "npm", "bin", basename(bin).toLowerCase().startsWith("npx") ? "npx-cli.js" : "npm-cli.js"); // the shim of npm/npx in the node folder
  if (!entry || !existsSync(entry)) throw new Error(`cannot resolve command shim ${bin} to a node entry; refusing to run it through a shell`);
  return { cmd: process.execPath, args: [...flags, entry, ...args] };
}

export const spawnSafe = (bin, args, o = {}) => { const r = resolveCommand(bin, args); return spawn(r.cmd, r.args, { ...o, shell: false }); };
/** Like spawnSync, but a refused shim returns { status: 127, stderr } instead of throwing. */
export const spawnSyncSafe = (bin, args, o = {}) => {
  let r; try { r = resolveCommand(bin, args); } catch (e) { return { status: 127, stdout: "", stderr: e.message, error: e }; }
  return spawnSync(r.cmd, r.args, { ...o, shell: false });
};
