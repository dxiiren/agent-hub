import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { providersRpc } from "./shared/rpc";
import { S } from "./client/strings";

type Field = { id: string; label: string; type: string; required?: boolean; help?: string };
type Kind = { type: string; label: string; fields: Field[]; slots: boolean; readOnlyTwin: boolean; nameHelp: string; ownProvider: boolean; account?: { by?: string; env?: string; arg?: string; help?: string; none?: string } };
type Added = { name: string; label?: string; type: string; model: string; url?: string; slots?: number; keySet?: boolean; routes: string[]; account?: string };
type Model = { id: string; label: string; hint?: string };
const CUSTOM = "__custom__";
const OFF = "off";

function Screen() {
  const rpc = useRpc(providersRpc);
  // an RPC that times out or fails must not leave the screen stuck on "Loading...": turn it into the same {error} shape as a tool refusal
  // rpc sits in a ref so `call` keeps one identity: a new identity per render re-ran the model-list effect and threw away its answer (the picker stayed empty). Also no call may stay pending forever.
  const rpcRef = useRef(rpc); rpcRef.current = rpc;
  const call = useCallback(async (input: Parameters<typeof rpc>[0]) => {
    let t: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([rpcRef.current(input), new Promise<never>((_, no) => { t = setTimeout(() => no(new Error(S.timedOut)), 100_000); })]); }
    catch (e: any) { return { error: String(e?.message ?? e) } as any; }
    finally { clearTimeout(t); }
  }, []);
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [routeTypes, setRouteTypes] = useState<Record<string, number>>({});
  const [added, setAdded] = useState<Added[]>([]);
  const [kind, setKind] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [slots, setSlots] = useState("2");
  const [account, setAccount] = useState("");
  const [twin, setTwin] = useState(true);
  const [pos, setPos] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Model[]>([]);
  const [custom, setCustom] = useState(false);
  const [modelErr, setModelErr] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [formKey, setFormKey] = useState(0);
  // the form is shown only after the first describe answered: "loading" -> "ready" | "error" (with a Retry), never an empty form
  const [load, setLoad] = useState<{ state: "loading" | "ready" | "error"; error?: string }>({ state: "loading" });

  const refresh = useCallback(async () => {
    // a cold plugin backend or a dropped request answers late or not at all: ask up to 3 times (25 s each) before showing the error
    let d: any = {};
    for (let i = 0; i < 3; i++) {
      d = await Promise.race([call({ verb: "describe" }), new Promise<any>((ok) => setTimeout(() => ok({ error: S.timedOut }), 25_000))]);
      if (!d.error && Array.isArray(d.kinds) && d.kinds.length) break;
      if (!d.error) d = { error: S.noKinds };
    }
    if (d.error) return setLoad({ state: "error", error: String(d.error) });
    setLoad({ state: "ready" });
    setKinds(d.kinds); setRouteTypes(d.routeTypes); setAdded(d.providers);
    // ?kind=<type> comes from Paseo's Add-provider list (scripts/paseo-web-patch.mjs): preselect that kind
    const want = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("kind") : null;
    setKind((k) => k || (d.kinds.some((x: Kind) => x.type === want) ? want! : d.kinds[0]?.type) || "");
  }, [call]);
  useEffect(() => { void refresh(); }, [refresh]);
  const reload = () => { setLoad({ state: "loading" }); void refresh(); };

  const k = kinds.find((x) => x.type === kind);
  const reset = () => { setCustom(false); setModelErr(null); setEditing(null); setVals({}); setName(""); setSlots("2"); setAccount(""); setTwin(true); setPos({}); setModels([]); setFormKey((n) => n + 1); };
  // The model list loads by itself: CLI kinds at once, endpoint kinds as soon as the link (and key) are typed. Nothing to guess.
  useEffect(() => {
    if (!kind || !k) return;
    const endpoint = k.fields.some((f) => f.id === "url");
    // any typed link goes to the server, which fills in http:// and says exactly what is wrong; nothing is dropped silently here
    if (endpoint && !(vals.url ?? "").trim()) { setModels([]); setModelErr(null); return; }
    let live = true;
    const t = setTimeout(async () => {
      setModelErr(null); setLoadingModels(true);
      const r: any = await call({ verb: "models", args: { kind, url: vals.url?.trim(), key: vals.key, provider: editing ?? undefined } });
      if (!live) return;
      setLoadingModels(false);
      if (r.error) { setModels([]); return setModelErr(r.error); }
      setModels(r.models);
      setVals((v) => (v.model || !r.models[0] ? v : { ...v, model: r.models[0].id }));
    }, endpoint ? 700 : 0);
    return () => { live = false; clearTimeout(t); setLoadingModels(false); };
  }, [kind, k, vals.url, vals.key, editing, call, retry]);
  // The plugin Settings inputs expose no autoComplete prop, so a password manager filled saved hub-login values into the model fields (the page port showed up there). Switch autofill off on this screen's inputs, and restore on leave.
  useEffect(() => {
    const touched = new Map<Element, [string | null, string | null, string | null]>();
    const apply = () => document.querySelectorAll("input, textarea").forEach((el) => {
      if (touched.has(el)) return;
      touched.set(el, [el.getAttribute("autocomplete"), el.getAttribute("data-1p-ignore"), el.getAttribute("data-lpignore")]);
      el.setAttribute("autocomplete", (el as HTMLInputElement).type === "password" ? "new-password" : "off"); el.setAttribute("data-1p-ignore", "true"); el.setAttribute("data-lpignore", "true");
    });
    apply(); const obs = new MutationObserver(apply); obs.observe(document.body, { childList: true, subtree: true });
    return () => { obs.disconnect(); touched.forEach((v, el) => { v[0] === null ? el.removeAttribute("autocomplete") : el.setAttribute("autocomplete", v[0]); v[1] === null ? el.removeAttribute("data-1p-ignore") : el.setAttribute("data-1p-ignore", v[1]); v[2] === null ? el.removeAttribute("data-lpignore") : el.setAttribute("data-lpignore", v[2]); }); };
  }, []);
  const routesArg = () => Object.entries(pos).filter(([, v]) => v !== OFF).map(([c, v]) => (v === "end" ? c : `${c}:${v}`)).join(",");
  const submit = async () => {
    setBusy(true); setMsg(null);
    const args: Record<string, unknown> = { ...vals, kind, slots, readOnly: twin ? "true" : "false", routes: routesArg(), ...(account && !editing ? { account } : {}) };
    if (editing) { args.name = editing; if (!vals.key) delete args.key; } else args.name = name;
    const r: any = await call({ verb: editing ? "edit" : "add", args });
    setBusy(false);
    if (r.error) return setMsg({ ok: false, text: `${S.failed} ${r.error}` });
    setMsg({ ok: true, text: (r.login ? S.loginOnce(r.login) + " " : "") + (r.needsRestart ? S.needsRestart : S.noRestart) });
    reset(); await refresh();
  };
  const startEdit = (a: Added) => {
    setEditing(a.name); setKind(a.type); setName(a.name); setVals({ model: a.model, ...(a.url ? { url: a.url } : {}), ...(a.label ? { label: a.label } : {}) }); setSlots(String(a.slots ?? 2));
    setPos(Object.fromEntries(a.routes.map((c) => [c, "end"]))); setModels([]); setFormKey((n) => n + 1); setMsg(null);
  };
  const del = async (n: string) => {
    setBusy(true);
    const r: any = await call({ verb: "remove", args: { name: n } });
    setBusy(false);
    setMsg(r.error ? { ok: false, text: `${S.failed} ${r.error}` } : { ok: true, text: S.removed(n) });
    if (editing === n) reset();
    await refresh();
  };

  const posOptions = (c: string) => [{ label: S.off, value: OFF }, { label: S.end, value: "end" },
    ...Array.from({ length: (routeTypes[c] ?? 0) + 1 }, (_, i) => ({ label: S.position(i + 1), value: String(i + 1) }))];
  const modelOptions = [...models.map((m) => ({ label: [m.label === m.id ? m.id : `${m.label} (${m.id})`, m.hint].filter(Boolean).join(" - "), value: m.id })), { label: S.customModel, value: CUSTOM }];

  return (
    load.state !== "ready" ? (
      <SettingsSection title={S.navTitle}>
        <SettingsCard>
          {load.state === "loading" ? <SettingsRow label={S.loading} /> : <>
            <SettingsRow label={S.loadFailed} error={load.error} />
            <SettingsAction label={S.navTitle} actionLabel={S.retry} onPress={reload} />
          </>}
        </SettingsCard>
      </SettingsSection>
    ) : <>
      <SettingsSection title={S.navTitle}>
        <SettingsCard>
          <SettingsRow label={S.intro} />
          <SettingsSelect label={S.kind} value={kind} options={kinds.map((x) => ({ label: x.label, value: x.type }))} disabled={!!editing} onValueChange={(v) => { setKind(v); setModels([]); setVals({}); setFormKey((n) => n + 1); }} />
          <SettingsInput key={`n${formKey}`} label={S.name} hint={k?.nameHelp ?? S.nameHint} initialValue={name} disabled={!!editing} placeholder={S.nameHint} onChangeText={setName} />
          {k?.ownProvider ? <SettingsInput key={`l${formKey}`} label={S.label} hint={S.labelHint} initialValue={vals.label ?? ""} onChangeText={(t) => setVals((v) => ({ ...v, label: t }))} /> : null}
          {k?.fields.filter((f) => f.type !== "model").map((f) => (
            <SettingsInput key={`${f.id}${formKey}`} label={f.label} hint={f.type === "secret" ? S.keyHint : f.help} initialValue={f.type === "secret" ? "" : vals[f.id] ?? ""} secureTextEntry={f.type === "secret"}
              onChangeText={(t) => setVals((v) => ({ ...v, [f.id]: t }))} />
          ))}
          <SettingsAction label={S.model} hint={loadingModels ? S.loading : modelErr ? undefined : models.length ? S.found(models.length) : S.modelsWait} actionLabel={loadingModels ? S.loading : modelErr ? S.retry : S.reload} disabled={loadingModels} onPress={() => setRetry((n) => n + 1)} />
          {modelErr ? <SettingsRow label={S.modelsFailed} error={modelErr} /> : null}
          <SettingsSelect label={S.model} value={custom || (vals.model && !models.some((m) => m.id === vals.model)) ? CUSTOM : vals.model ?? ""} options={modelOptions}
            onValueChange={(v) => { if (v === CUSTOM) { setCustom(true); setVals((x) => ({ ...x, model: "" })); } else { setCustom(false); setVals((x) => ({ ...x, model: v })); } }} />
          {custom || (vals.model && !models.some((m) => m.id === vals.model)) ? <SettingsInput key={`m${formKey}`} label={S.modelType} initialValue={vals.model ?? ""} onChangeText={(t) => setVals((v) => ({ ...v, model: t }))} /> : null}
          {k?.account?.by === "config-dir" && !editing ? <SettingsInput key={`a${formKey}`} label={S.account} hint={S.accountHint(k.account.env ?? k.account.arg ?? "")} initialValue={account} onChangeText={setAccount} /> : null}
          {k?.account && k.account.by !== "config-dir" ? <SettingsRow label={S.account} hint={k.account.by === "endpoint" ? k.account.help : `${S.noAccounts} ${k.account.none ?? ""}`} /> : null}
          {k?.slots ? <SettingsInput key={`s${formKey}`} label={S.slots} initialValue={slots} onChangeText={setSlots} /> : null}
          {k?.readOnlyTwin ? <SettingsSwitch label={S.readOnlyTwin} value={twin} onValueChange={setTwin} /> : null}
          <SettingsRow label={S.routes} hint={S.routesHint} />
          {Object.keys(routeTypes).map((c) => (
            <SettingsSelect key={c} label={c} value={pos[c] ?? OFF} options={posOptions(c)} onValueChange={(v) => setPos((p) => ({ ...p, [c]: v }))} />
          ))}
          <SettingsAction label={editing ? `${S.save}: ${editing}` : S.add} actionLabel={busy ? S.adding : editing ? S.save : S.add} disabled={busy} onPress={() => void submit()} />
          {editing ? <SettingsAction label={editing} actionLabel={S.cancelEdit} onPress={reset} /> : null}
          {msg ? <SettingsRow label={msg.text} error={msg.ok ? null : msg.text} /> : null}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={S.existing}>
        <SettingsCard>
          {added.length === 0 ? <SettingsRow label={S.none} /> : null}
          {added.map((a) => (
            <SettingsRow key={a.name} label={`${a.name}  (${a.type}${a.account ? `, account ${a.account}` : ""})`} hint={`${a.model}${a.url ? `  ${a.url}` : ""}${a.keySet ? `  ${S.keySet}` : ""}  slots ${a.slots ?? "-"}  ${a.routes.join(", ") || "-"}`}>
              <SettingsAction label={a.name} actionLabel={S.edit} onPress={() => startEdit(a)} />
              <SettingsAction label={a.name} actionLabel={S.remove} disabled={busy} onPress={() => void del(a.name)} />
            </SettingsRow>
          ))}
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

export default function contribute(client: PluginClientContext) {
  const screen = client.addSettingsScreen({ id: "providers", title: S.navTitle, icon: "Server", Component: Screen });
  // Paseo has no extension point on its Providers page or its "Add provider" dialog (see docs/paseo-upstream-notes.md), so the form is also one command-palette entry away.
  const command = client.addCommandCenterItem({ id: "add-provider", title: S.navTitle, icon: "Server", keywords: ["provider", "endpoint", "model", "add"], context: "global", onSelect: (c) => c.openSettings("providers") });
  return () => { screen(); command(); };
}
