// The slot budget the hub may use right now. Seam for the laptop-based dynamic budget (owner ask 07-11): replace the body, keep the shape.
// Today: effective = sum of the slots of the providers that are enabled (a disabled provider contributes 0).
/** @param {{slots?: Record<string, number>, enabled?: Record<string, boolean>}} s @returns {{configured:number, effective:number, perProvider:Record<string,number>, reasons:string[], source:string}} */
export function effectiveBudget({ slots = {}, enabled = {} } = {}) {
  const perProvider = {}; let configured = 0, effective = 0; const reasons = [];
  for (const [id, n] of Object.entries(slots)) {
    configured += n;
    if (enabled[id] === false) { perProvider[id] = 0; reasons.push(`${id}: disabled in Paseo, its ${n} slot${n === 1 ? "" : "s"} do not count`); } else { perProvider[id] = n; effective += n; }
  }
  return { configured, effective, perProvider, reasons, source: "configured-slots" };
}
