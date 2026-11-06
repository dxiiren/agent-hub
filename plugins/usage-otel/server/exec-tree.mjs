// execFile whose timeout kills the WHOLE child tree (Windows: taskkill /T; posix: the process group), no shell. A plain execFile timeout
// kills only the direct child, so a poller's own children (the Qoder SDK's bundled CLI) outlived it.
import { spawn, spawnSync } from "node:child_process";

export function killTree(pid, platform = process.platform) {
  try {
    if (platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, shell: false });
    else process.kill(-pid, "SIGKILL");
  } catch { /* already gone */ }
}

/** cb(err, stdout) like execFile; err.killed is true on timeout. */
export function execFileTree(cmd, args, { timeout = 0, env = process.env } = {}, cb) {
  let out = "", done = false, timer;
  const c = spawn(cmd, args, { env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"] });
  const end = (e) => { if (done) return; done = true; clearTimeout(timer); cb(e, out); };
  c.stdout.setEncoding("utf8"); c.stdout.on("data", (d) => { out += d; });
  c.on("error", end);
  c.on("close", (code) => {
    if (process.platform !== "win32") { try { process.kill(-c.pid, "SIGKILL"); } catch { /* none left */ } } // reap what the poller left in its group
    end(code ? Object.assign(new Error(`exit ${code}`), { code }) : null);
  });
  if (timeout > 0) timer = setTimeout(() => { killTree(c.pid); end(Object.assign(new Error("timeout"), { killed: true })); }, timeout);
  return c;
}
