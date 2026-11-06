// Agent helper processes that outlive the agent: Qoder starts `bash -c` to write a shell snapshot (<qoder config dir>/shell-snapshots/snapshot-bash-*.sh); when the daemon is stopped
// the agent dies first and that shell is left with a dead parent (it lingered about 5 minutes after a restart). `agent-hub reap-agent-orphans` (run by `just down` and `cleanup`) stops
// exactly those: a process whose command line names a shell snapshot AND whose parent process no longer exists. A live agent's snapshot shell always has a live parent, so it is never touched.
import { spawnSync } from "node:child_process";

const SNAPSHOT = /shell-snapshots[\\/]+snapshot-bash-/i;
/** procs = [{pid, ppid, cmd}]. Returns the pids that are orphaned agent shell snapshots (parent not in the list). Pure. */
export function orphanSnapshotPids(procs, self = process.pid) {
  const live = new Set(procs.map((p) => p.pid));
  return procs.filter((p) => p.pid !== self && SNAPSHOT.test(p.cmd ?? "") && p.ppid && !live.has(p.ppid)).map((p) => p.pid);
}

/** Running processes as [{pid, ppid, cmd}] (Windows: CIM; POSIX: ps). [] when the listing fails. */
export function listProcs(run = spawnSync) {
  try {
    if (process.platform === "win32") {
      const r = run("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"], { encoding: "utf8", timeout: 30000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const j = JSON.parse(r.stdout || "[]");
      return (Array.isArray(j) ? j : [j]).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, cmd: p.CommandLine ?? "" }));
    }
    const r = run("ps", ["-eo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
    return String(r.stdout).split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
  } catch { return []; }
}

/** Stop every orphaned agent shell snapshot; returns the pids stopped. `kill` is injectable for tests. */
export function reapAgentOrphans({ procs = listProcs(), kill = (pid) => process.kill(pid, "SIGKILL") } = {}) {
  const out = [];
  for (const pid of orphanSnapshotPids(procs)) { try { kill(pid); out.push(pid); } catch { /* already gone */ } }
  return out;
}
