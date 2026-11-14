#!/usr/bin/env node
// claude-clean launcher: claude <args>, with the hub's read-only rules merged into whatever --settings Paseo passes (Paseo adds its own
// --settings after ours and the last one wins, so a plain extra --settings flag is silently dropped).
// The rules apply only in a read-only permission mode (plan, default): code-edit tasks run in bypassPermissions and keep every tool.
// A PreToolUse hook (plugins/routing/claude-readhook.mjs) limits Read/Grep/Glob to the task cwd plus routes.readAllow, like readguard does for Qwen.
// In that case the run is also --restricted (HUBFIX4, 15-11): no user, project or local settings, no CLAUDE.md, no installed plugins or plugin hooks. The old `--setting-sources user` still loaded the owner's plugins: a "ponytail" SessionStart hook made Haiku end every summary with a "Skipped: ..." footer and a plan-mode write. Only the hub's own --settings (rules + read hook) apply; --add-dir keeps routes.readAllow readable (--restricted confines file tools to cwd + add-dir).
// Usage: claude-wrap.mjs <claude-binary> <mcp-config> <rules.json> [claude args...]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const READONLY_MODES = ["plan", "default"];
export const modeOf = (args) => { const i = args.findIndex((a) => a === "--permission-mode" || a.startsWith("--permission-mode=")); if (i < 0) return undefined; return args[i].includes("=") ? args[i].split("=")[1] : args[i + 1]; };

const HOOK = resolve(fileURLToPath(import.meta.url), "..", "..", "plugins", "routing", "claude-readhook.mjs").split("\\").join("/");
const fwd = (p) => p.split("\\").join("/");
/** The PreToolUse entry that keeps Read/Grep/Glob inside the task cwd (same boundary as readguard). */
export const hookEntry = () => ({ matcher: "Read|Grep|Glob|LS|NotebookRead", hooks: [{ type: "command", command: `"${fwd(process.execPath)}" "${HOOK}"` }] });

export function mergeSettings(args, rules, hook) {
  const out = []; const merged = JSON.parse(JSON.stringify(rules));
  const add = (o) => { for (const [k, v] of Object.entries(o)) { if (k === "permissions") for (const [pk, pv] of Object.entries(v)) merged.permissions[pk] = Array.isArray(pv) ? [...new Set([...(merged.permissions[pk] ?? []), ...pv])] : pv; else merged[k] = v; } };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--settings" && i + 1 < args.length) { const v = args[++i]; try { add(JSON.parse(v.trim().startsWith("{") ? v : readFileSync(v, "utf8"))); } catch { /* unreadable value: ours only */ } } else out.push(args[i]);
  }
  if (hook) merged.disableAllHooks = false;
  if (hook) merged.hooks = { ...merged.hooks, PreToolUse: [hook, ...(merged.hooks?.PreToolUse ?? [])] };
  return [...out, "--settings", JSON.stringify(merged)];
}

/** Final claude args for this launch. */
export function buildArgs(rest, rules, mcp, allowDirs = []) {
  if (rest[0] === "--version") return rest;
  const base = ["--strict-mcp-config", "--mcp-config", mcp];
  if (!READONLY_MODES.includes(modeOf(rest))) return [...base, ...rest];
  const noProject = []; // every --setting-sources form is dropped, then one `user` is appended: project/local allow rules and hooks cannot return
  for (let i = 0; i < rest.length; i++) { if (rest[i] === "--setting-sources") i++; else if (!rest[i].startsWith("--setting-sources=") && !/^--(allow-)?dangerously-skip-permissions$/.test(rest[i])) noProject.push(rest[i]); } // Paseo always adds --allow-dangerously-skip-permissions, which --restricted refuses (HUBFIX4: "bypassPermissions not supported in restricted mode"); a read-only task must never be allowed to skip permissions anyway
  return [...base, ...mergeSettings(noProject, rules, hookEntry()), "--restricted", ...allowDirs.flatMap((d) => ["--add-dir", d])];
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const [bin, mcp, rulesFile, ...rest] = process.argv.slice(2);
  let allowDirs = []; try { const { loadRoutes } = await import("../plugins/routing/route.mjs"); allowDirs = (loadRoutes().readAllow ?? []).filter((d) => typeof d === "string" && d); } catch { /* no routes file: cwd only */ }
  const finalArgs = buildArgs(rest, JSON.parse(readFileSync(rulesFile, "utf8")), mcp, allowDirs);
  // test hook: print the launch instead of starting claude (a Windows .cmd stand-in cannot be spawned without a shell)
  if (process.env.AGENT_HUB_WRAP_DRYRUN === "1") { console.log(JSON.stringify({ bin, args: finalArgs })); process.exit(0); }
  const c = spawn(bin, finalArgs, { stdio: "inherit" });
  c.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
  c.on("error", (e) => { console.error(String(e)); process.exit(127); });
}
