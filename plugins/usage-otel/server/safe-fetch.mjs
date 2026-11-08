// A usage source's fetch must never block Paseo's provider status or routing (Paseo RPC limit is ~10 s).
// Returns the last good value at once, refreshes in the background, and answers within `ms` even on the first call.
export function safeFetch(fn, { ms = 3000 } = {}) {
  const cache = new Map(); // key -> { v, p }
  return async (input) => {
    const key = JSON.stringify(input ?? {});
    const e = cache.get(key) ?? { v: undefined, p: undefined };
    cache.set(key, e);
    if (!e.p) {
      e.p = Promise.resolve().then(() => fn(input)).then((v) => { e.v = v; }, (err) => { e.v ??= { status: "error", error: String(err?.message ?? err).slice(0, 200) }; })
        .finally(() => { e.p = undefined; });
    }
    const timeout = new Promise((r) => setTimeout(r, ms, "timeout"));
    await Promise.race([e.p, timeout]);
    return e.v ?? { status: "error", error: "usage fetch still running; try again" };
  };
}
