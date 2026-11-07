// Model allow-list (Routing & slots page, `agent-hub routes set <provider> --models a,b`): routes.allowedModels = { <provider>: [model id, ...] }.
// A provider without an entry may use any model. A chain entry that names no model ("qwen-code": the endpoint's own model) is not restricted.
const own = (o, k) => (o != null && typeof o === "object" && Object.hasOwn(o, k) ? o[k] : undefined);
/** prov = a RESOLVED entry ("codex/gpt-6.1-terra", "qoder/qmodel_x", "qwen-code"). Returns an error string when its model is not allowed, else null. */
export function modelNotAllowed(routes, prov) {
  const s = String(prov); const i = s.indexOf("/");
  if (i < 0) return null;
  const list = own(routes?.allowedModels, s.slice(0, i));
  if (!Array.isArray(list)) return null;
  const model = s.slice(i + 1);
  return list.includes(model) ? null : `model ${model} is not allowed for ${s.slice(0, i)} (allowed: ${list.join(", ") || "none"}); change it in Settings > Routing & slots or with agent-hub routes set`;
}
