#!/usr/bin/env node
// Claude PreToolUse hook for read-only tasks (merged into the settings by scripts/claude-wrap.mjs): the same file boundary readguard gives
// the Qwen providers. Only Read of one regular file may touch only the task cwd plus routes.readAllow; anything else, or any error, is blocked (exit 2).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { pathAllowed } from "./readguard.mjs";

/** { ok, why } for one tool call. input = the hook's stdin JSON. */
export function decide(input, readAllow = [], env = process.env, home) {
  const roots = [input.cwd, ...readAllow].filter(Boolean);
  if (!input.cwd) return { ok: false, why: "no cwd" };
  const ti = input.tool_input ?? {};
  switch (input.tool_name) {
    case "NotebookRead": return pathAllowed(ti.notebook_path, roots, env, home);
    case "Read": return pathAllowed(ti.file_path, roots, env, home);
    // Glob, Grep and LS are denied like readguard denies grep/glob/ls: a search inside cwd reaches .env and credentials files.
    default: return { ok: false, why: `tool ${input.tool_name} is not allowed in a read-only task` };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    let allow = [];
    try { const { loadRoutes } = await import("./route.mjs"); allow = loadRoutes().readAllow ?? []; } catch { /* no routes file: cwd only */ }
    const v = decide(input, allow);
    if (v.ok) process.exit(0);
    console.error(`read-only task: ${v.why}`); process.exit(2);
  } catch (e) { console.error(`read-only task: hook error ${e}`); process.exit(2); }
}
