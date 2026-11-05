#!/usr/bin/env node
// claude-clean launcher: claude <args> with the hub's read rules merged into whatever --settings Paseo passes (Paseo adds its own
// --settings after ours and the last one wins, so a plain extra --settings flag is silently dropped).
// Usage: claude-wrap.mjs <claude-binary> <mcp-config> <rules.json> [claude args...]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function mergeSettings(args, rules) {
  const out = []; const merged = JSON.parse(JSON.stringify(rules));
  const add = (o) => { for (const [k, v] of Object.entries(o)) { if (k === "permissions") for (const [pk, pv] of Object.entries(v)) merged.permissions[pk] = Array.isArray(pv) ? [...new Set([...(merged.permissions[pk] ?? []), ...pv])] : pv; else merged[k] = v; } };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--settings" && i + 1 < args.length) { const v = args[++i]; try { add(JSON.parse(v.trim().startsWith("{") ? v : readFileSync(v, "utf8"))); } catch { /* unreadable value: ours only */ } } else out.push(args[i]);
  }
  return [...out, "--settings", JSON.stringify(merged)];
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const [bin, mcp, rulesFile, ...rest] = process.argv.slice(2);
  const rules = JSON.parse(readFileSync(rulesFile, "utf8"));
  const args = rest[0] === "--version" ? rest : ["--strict-mcp-config", "--mcp-config", mcp, ...mergeSettings(rest, rules)];
  const c = spawn(bin, args, { stdio: "inherit" });
  c.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
  c.on("error", (e) => { console.error(String(e)); process.exit(127); });
}
