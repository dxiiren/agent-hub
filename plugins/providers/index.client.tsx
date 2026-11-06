import { useCallback, useEffect, useState } from "react";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { providersRpc } from "./shared/rpc";
import { S } from "./client/strings";

type Field = { id: string; label: string; type: string; required?: boolean; help?: string };
type Kind = { type: string; label: string; fields: Field[]; slots: boolean; readOnlyTwin: boolean; nameHelp: string; ownProvider: boolean };
type Added = { name: string; label?: string; type: string; model: string; url?: string; slots?: number; keySet?: boolean; routes: string[] };
type Model = { id: string; label: string };
const OFF = "off";

function Screen() {
  const call = useRpc(providersRpc);
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [routeTypes, setRouteTypes] = useState<Record<string, number>>({});
  const [added, setAdded] = useState<Added[]>([]);
  const [kind, setKind] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [slots, setSlots] = useState("2");
  const [twin, setTwin] = useState(true);
  const [pos, setPos] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Model[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [formKey, setFormKey] = useState(0);

  const refresh = useCallback(async () => {
    const d: any = await call({ verb: "describe" });
    if (d.error) return setMsg({ ok: false, text: `${S.failed} ${d.error}` });
    setKinds(d.kinds); setRouteTypes(d.routeTypes); setAdded(d.providers);
    setKind((k) => k || d.kinds[0]?.type || "");
  }, [call]);
  useEffect(() => { void refresh(); }, [refresh]);

  const k = kinds.find((x) => x.type === kind);
  const reset = () => { setEditing(null); setVals({}); setName(""); setSlots("2"); setTwin(true); setPos({}); setModels([]); setFormKey((n) => n + 1); };
  const loadModels = async () => {
    setBusy(true); setMsg(null);
    const r: any = await call({ verb: "models", args: { kind, url: vals.url, key: vals.key } });
    setBusy(false);
    if (r.error) return setMsg({ ok: false, text: `${S.failed} ${r.error}` });
    setModels(r.models);
    if (!vals.model && r.models[0]) setVals((v) => ({ ...v, model: r.models[0].id }));
  };
  const routesArg = () => Object.entries(pos).filter(([, v]) => v !== OFF).map(([c, v]) => (v === "end" ? c : `${c}:${v}`)).join(",");
  const submit = async () => {
    setBusy(true); setMsg(null);
    const args: Record<string, unknown> = { ...vals, kind, slots, readOnly: twin ? "true" : "false", routes: routesArg() };
    if (editing) { args.name = editing; if (!vals.key) delete args.key; } else args.name = name;
    const r: any = await call({ verb: editing ? "edit" : "add", args });
    setBusy(false);
    if (r.error) return setMsg({ ok: false, text: `${S.failed} ${r.error}` });
    setMsg({ ok: true, text: r.needsRestart ? S.needsRestart : S.noRestart });
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
  const modelOptions = models.map((m) => ({ label: m.label === m.id ? m.id : `${m.label} (${m.id})`, value: m.id }));

  return (
    <>
      <SettingsSection title={S.navTitle}>
        <SettingsCard>
          <SettingsRow label={S.intro} />
          {msg ? <SettingsRow label={msg.text} error={msg.ok ? null : msg.text} /> : null}
          <SettingsSelect label={S.kind} value={kind} options={kinds.map((x) => ({ label: x.label, value: x.type }))} disabled={!!editing} onValueChange={(v) => { setKind(v); setModels([]); setVals({}); setFormKey((n) => n + 1); }} />
          <SettingsInput key={`n${formKey}`} label={S.name} hint={k?.nameHelp ?? S.nameHint} initialValue={name} disabled={!!editing} placeholder={S.nameHint} onChangeText={setName} />
          {k?.ownProvider ? <SettingsInput key={`l${formKey}`} label={S.label} hint={S.labelHint} initialValue={vals.label ?? ""} onChangeText={(t) => setVals((v) => ({ ...v, label: t }))} /> : null}
          {k?.fields.filter((f) => f.type !== "model").map((f) => (
            <SettingsInput key={`${f.id}${formKey}`} label={f.label} hint={f.type === "secret" ? S.keyHint : f.help} initialValue={f.type === "secret" ? "" : vals[f.id] ?? ""} secureTextEntry={f.type === "secret"}
              onChangeText={(t) => setVals((v) => ({ ...v, [f.id]: t }))} />
          ))}
          <SettingsAction label={S.model} hint={vals.model ? vals.model : undefined} actionLabel={busy ? S.loading : S.loadModels} disabled={busy} onPress={() => void loadModels()} />
          {models.length ? <SettingsSelect label={S.modelPick} value={vals.model ?? ""} options={modelOptions} onValueChange={(v) => setVals((x) => ({ ...x, model: v }))} /> : null}
          <SettingsInput key={`m${formKey}${vals.model ?? ""}`} label={S.modelType} initialValue={vals.model ?? ""} onChangeText={(t) => setVals((v) => ({ ...v, model: t }))} />
          {k?.slots ? <SettingsInput key={`s${formKey}`} label={S.slots} initialValue={slots} onChangeText={setSlots} /> : null}
          {k?.readOnlyTwin ? <SettingsSwitch label={S.readOnlyTwin} value={twin} onValueChange={setTwin} /> : null}
          <SettingsRow label={S.routes} hint={S.routesHint} />
          {Object.keys(routeTypes).map((c) => (
            <SettingsSelect key={c} label={c} value={pos[c] ?? OFF} options={posOptions(c)} onValueChange={(v) => setPos((p) => ({ ...p, [c]: v }))} />
          ))}
          <SettingsAction label={editing ? `${S.save}: ${editing}` : S.add} actionLabel={busy ? S.adding : editing ? S.save : S.add} disabled={busy || (!editing && !name)} onPress={() => void submit()} />
          {editing ? <SettingsAction label={editing} actionLabel={S.cancelEdit} onPress={reset} /> : null}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={S.existing}>
        <SettingsCard>
          {added.length === 0 ? <SettingsRow label={S.none} /> : null}
          {added.map((a) => (
            <SettingsRow key={a.name} label={`${a.name}  (${a.type})`} hint={`${a.model}${a.url ? `  ${a.url}` : ""}${a.keySet ? `  ${S.keySet}` : ""}  slots ${a.slots ?? "-"}  ${a.routes.join(", ") || "-"}`}>
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
