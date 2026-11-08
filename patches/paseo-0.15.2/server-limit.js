/*agent-hub-server-rev:2*/
// One probe budget for the whole daemon: Paseo limits probes per provider (4 each), so 100 enabled providers started 100 cold CLI processes at once and starved the daemon's HTTP for a minute.
const __ahProbeLimit = pLimit(4);
function __ahDiscoveryLimit() {
    const own = pLimit({ concurrency: 4, rejectOnClear: true });
    const limited = (fn) => own(() => __ahProbeLimit(fn));
    limited.clearQueue = () => own.clearQueue();
    return limited;
}
// A failed probe (an npx/npm install dump, a stack) shows as one short line in Settings > Providers; the full text stays in the provider diagnostic.
function __ahShortError(text) {
    const all = String(text ?? "").split(/\r?\n/).map((l) => l.replace(/^npm (error|ERR!|warn)\s*/i, "").trim()).filter(Boolean);
    if (all.length <= 1 && all.join("").length <= 160) return all.join("");
    const key = all.find((l) => /\b(E[A-Z]{3,}|404|not found|not recognized|timed? ?out|denied|refused|failed|cannot|could not)\b/i.test(l)) ?? all[0] ?? "";
    return `${key.slice(0, 160)} (full output: open the provider and run its diagnostic)`;
}
