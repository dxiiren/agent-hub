// Tells a stopped daemon (connection refused) from a hung one (port open, no answer): the 05-11 23:20 stall froze Paseo's event loop for
// 220 s with the port still listening, and `just doctor` only said "down". Upstream cause: getpaseo/paseo#8244, #8670, #3426.
export async function probeDaemon(port, { fetchFn = fetch, timeoutMs = Number(process.env.AGENT_HUB_HEALTH_MS || 5000) } = {}) {
  try {
    const r = await fetchFn(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    await r.text();
    return r.status === 200 ? { state: 'up' } : { state: 'sick', detail: `/api/health answered ${r.status}` };
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { state: 'hung', detail: `port ${port} accepts connections but /api/health gave no answer in ${timeoutMs} ms` };
    return { state: 'down', detail: String(e?.cause?.code || e?.message || e) };
  }
}
export const daemonAdvice = (p) => p.state === 'hung'
  ? `daemon is HUNG (${p.detail}): its event loop is stalled, not stopped. Known upstream Paseo bug on Windows with many workspaces/worktrees (getpaseo/paseo#8244, #8670, #3426). Ask the session that owns the daemon to restart it; do not start a second one.`
  : p.state === 'sick' ? `daemon is unhealthy (${p.detail})` : `daemon is down (${p.detail}): run \`just up\``;
