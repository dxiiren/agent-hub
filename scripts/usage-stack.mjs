// Probes the usage stack. Any HTTP answer from the OTLP collector counts as up (its / returns 404); Grafana and Prometheus must answer 200.
export const stackUrls = (env = process.env) => ({
  collector: `http://127.0.0.1:${env.HUB_OTLP_HTTP_PORT || 4318}/`,
  prometheus: `http://127.0.0.1:${env.HUB_PROM_PORT || 9090}/-/ready`,
  grafana: `http://127.0.0.1:${env.HUB_GRAFANA_PORT || 3000}/api/health`,
});
export async function probeStack(urls = stackUrls(), fetchFn = fetch) {
  const out = [];
  for (const [name, url] of Object.entries(urls)) {
    try { const r = await fetchFn(url, { signal: AbortSignal.timeout(4000) }); out.push({ name, url, ok: name === 'collector' ? r.status > 0 : r.status === 200 }); }
    catch { out.push({ name, url, ok: false }); }
  }
  return out;
}
