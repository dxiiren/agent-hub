// The slot budget the hub may use right now (owner ask 07-11: "slot must be based on laptop otherwise it will hang").
// effective = min(config side, laptop side).
//  config side : per-provider slots, minus disabled/unavailable providers; their slots move to enabled ones in chain priority, never above that provider's own cap (routes.slotCaps, default = its slots).
//  laptop side : busy + floor((free RAM - floor) / RAM cost of one agent); no new agent while CPU is above cpuMaxPct. Costs per kind are measured defaults, override with routes.agentCostGb.
import os from "node:os";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Peak working set of one agent's whole process tree (GB). claude, codex, qoder: measured 07-11 on this laptop from real routes (claude 0.5, codex 0.25, qoder 0.24 running / 0.17 idle); qwen (CLI + ACP proxy) and local (llama-server host RAM) are estimates until a run is measured.
export const DEFAULT_COST_GB = { claude: 0.5, codex: 0.25, qoder: 0.25, qwen: 0.3, local: 0.9, other: 0.4 };
export const kindOf = (id) => /laptop|llama|local/.test(id) ? "local" : /^claude/.test(id) ? "claude" : /^codex/.test(id) ? "codex" : /^qoder/.test(id) ? "qoder" : /^qwen/.test(id) ? "qwen" : "other";
export const costGb = (id, routes = {}) => routes.agentCostGb?.[id] ?? DEFAULT_COST_GB[kindOf(id)];

/** Provider ids in chain priority: first appearance walking the task types in file order (code-edit first), then the rest. */
export function chainOrder(routes = {}) {
  const seen = []; const baseOf = (e) => String(e).split("/")[0];
  for (const c of Object.values(routes.routes ?? {})) for (const e of c ?? []) if (!seen.includes(baseOf(e))) seen.push(baseOf(e));
  for (const id of Object.keys(routes.slots ?? {})) if (!seen.includes(id)) seen.push(id);
  return seen;
}

/**
 * @param {{slots?:Record<string,number>, enabled?:Record<string,boolean>, caps?:Record<string,number>, order?:string[], freeGb?:number, cpuPct?:number, busy?:number, floorGb?:number, cpuMaxPct?:number, cost?:(id:string)=>number}} s
 * @returns {{configured:number, effective:number, configEffective:number, laptopCap:number|null, perProvider:Record<string,number>, reasons:string[], source:string}}
 */
export function effectiveBudget({ slots = {}, enabled = {}, caps = {}, order = Object.keys(slots), freeGb, cpuPct, busy = 0, floorGb = 2, cpuMaxPct = 85, cost = (id) => DEFAULT_COST_GB[kindOf(id)] } = {}) {
  const perProvider = {}; let configured = 0, freed = 0; const reasons = [];
  for (const [id, n] of Object.entries(slots)) {
    configured += n;
    if (enabled[id] === false) { perProvider[id] = 0; freed += n; reasons.push(`${id}: switched off (${n} slot${n === 1 ? "" : "s"})`); } else perProvider[id] = n;
  }
  const rank = (id) => { const i = order.indexOf(id); return i < 0 ? 1e9 : i; };
  for (const id of Object.keys(perProvider).filter((x) => enabled[x] !== false).sort((a, b) => rank(a) - rank(b))) {
    if (freed <= 0) break;
    const give = Math.min(freed, Math.max(0, (caps[id] ?? slots[id]) - perProvider[id]));
    if (give > 0) { perProvider[id] += give; freed -= give; reasons.push(`${id}: takes over ${give} slot${give === 1 ? "" : "s"} from switched-off providers (${perProvider[id]} in all)`); }
  }
  if (freed > 0) reasons.push(`${freed} slot${freed === 1 ? "" : "s"} of switched-off providers ${freed === 1 ? "is" : "are"} not used: no other provider has room for ${freed === 1 ? "it" : "them"} under its cap`);
  const configEffective = Object.values(perProvider).reduce((a, b) => a + b, 0);
  let laptopCap = null; let source = "configured-slots";
  if (Number.isFinite(freeGb)) {
    source = "laptop";
    const w = Object.entries(perProvider).filter(([, n]) => n > 0); const tot = w.reduce((a, [, n]) => a + n, 0) || 1;
    const per = w.reduce((a, [id, n]) => a + cost(id) * n, 0) / tot || DEFAULT_COST_GB.other;
    const room = Math.max(0, Math.floor((freeGb - floorGb) / per));
    laptopCap = busy + room;
    if (room === 0) reasons.push(`laptop: ${freeGb.toFixed(2)} GB free, floor ${floorGb} GB, one agent needs about ${per.toFixed(2)} GB: nothing new starts until RAM frees`);
    else if (laptopCap < configEffective) reasons.push(`the laptop has room for ${room} more agent${room === 1 ? "" : "s"} (${freeGb.toFixed(2)} GB free - ${floorGb} GB floor, at about ${per.toFixed(2)} GB each, rounded down)${busy ? `, on top of ${busy} running now = ${laptopCap}` : ""}; the providers' slots add up to ${configEffective}`);
    if (Number.isFinite(cpuPct) && cpuPct > cpuMaxPct) { laptopCap = Math.min(laptopCap, busy); reasons.push(`laptop: CPU ${Math.round(cpuPct)}% is above ${cpuMaxPct}%: nothing new starts until it drops`); }
  }
  return { configured, effective: laptopCap === null ? configEffective : Math.min(configEffective, laptopCap), configEffective, laptopCap, perProvider, reasons, source };
}

// Free RAM the way the OS means it. Windows: perf counter "\Memory\Available MBytes" = free + standby (reclaimable cache), via CIM so it works on any display language.
// os.freemem() on Windows is FreePhysicalMemory (free list only) and ignores the standby cache; the floor (minFreeRamGb) is judged on Available.
// Linux: MemAvailable from /proc/meminfo. Falls back to os.freemem() when the counter cannot be read. Cached 5 s (one PowerShell call is about 0.7 s). Injectable for tests.
let availCache = null;
export function availableGb({ now = Date.now(), platform = process.platform, run = spawnSync, readFile = readFileSync, fallback = () => os.freemem() / 2 ** 30, ttl = 5000 } = {}) {
  if (availCache && now - availCache.at < ttl) return availCache.gb;
  let gb;
  try {
    if (platform === "win32") {
      const r = run("powershell.exe", ["-NoProfile", "-Command", "(Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory).AvailableMBytes"], { encoding: "utf8", timeout: 8000, windowsHide: true });
      const mb = Number(String(r.stdout ?? "").trim()); if (r.status === 0 && mb > 0) gb = mb / 1024;
    } else if (platform === "linux") {
      const kb = Number(/MemAvailable:\s+(\d+)/.exec(String(readFile("/proc/meminfo", "utf8")))?.[1]); if (kb > 0) gb = kb / 1048576;
    }
  } catch { /* fall back */ }
  gb ??= fallback();
  availCache = { at: now, gb };
  return gb;
}
export const resetAvailableCache = () => { availCache = null; };

let cpuPrev = null; let snap = null;
const cpuTimes = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, total: 0 });
/** Available RAM (GB, see availableGb) and CPU % of this machine, cached 10 s. CPU is the load since the previous reading (first call: since boot, so treated as unknown). Injectable for tests. */
export function laptopNow({ now = Date.now(), freeMem = () => availableGb(), cpu = cpuTimes, ttl = 10000 } = {}) {
  if (snap && now - snap.at < ttl) return snap;
  const c = cpu(); let cpuPct;
  if (cpuPrev && c.total > cpuPrev.total) cpuPct = 100 * (1 - (c.idle - cpuPrev.idle) / (c.total - cpuPrev.total));
  cpuPrev = c; snap = { at: now, freeGb: freeMem(), cpuPct };
  return snap;
}
export const resetLaptopCache = () => { snap = null; cpuPrev = null; };

let lastDrop = 0;
/** Optional (routes.dropWslCache, Windows only, off by default): drop the WSL page cache, which is reclaimable but counted as used by Windows. At most once a minute; every call is logged to <logDir>/budget.log. Returns the log line or null. */
export function dropWslCache({ run, logDir, now = Date.now(), platform = process.platform } = {}) {
  if (platform !== "win32" || now - lastDrop < 60000) return null;
  lastDrop = now;
  const r = run ? run() : spawnSync("wsl.exe", ["-u", "root", "-e", "sh", "-c", "sync; echo 3 > /proc/sys/vm/drop_caches"], { timeout: 20000, windowsHide: true });
  const line = `${new Date(now).toISOString()} drop WSL page cache: ${r?.status === 0 ? "ok" : `failed (status ${r?.status}, ${String(r?.stderr ?? r?.error ?? "").replace(/\0/g, "").slice(0, 120)})`}`;
  try { if (logDir) { mkdirSync(logDir, { recursive: true }); appendFileSync(join(logDir, "budget.log"), line + "\n"); } } catch { /* best effort */ }
  resetLaptopCache();
  return line;
}
export const resetDropClock = () => { lastDrop = 0; };

export const markerAge = 30 * 60 * 1000;
export const pidAlive = (n) => { const pid = Number(n.split("-")[1]); if (!pid) return true; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
/** Live routes (alive pid, fresh marker) that hold a provider, in start order. A killed route's marker holds nothing. */
export function heldIn(dir) {
  try {
    const stamp = (n) => Number(n.split("-")[2]?.replace(".json", "")) || 0;
    return readdirSync(dir).filter((n) => n.startsWith("t-") && Date.now() - statSync(join(dir, n)).mtimeMs < markerAge && pidAlive(n))
      .map((n) => { try { return { n, provider: JSON.parse(readFileSync(join(dir, n), "utf8")).provider ?? null }; } catch { return { n, provider: null }; } })
      .sort((x, y) => stamp(x.n) - stamp(y.n) || x.n.localeCompare(y.n)).filter((x) => x.provider);
  } catch { return []; }
}
