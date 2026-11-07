import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { routingRpc } from "../shared/rpc";
import { R } from "./routing-strings";

type Prov = { id: string; label: string; status: string | null; enabled: boolean; slots: number | null; cap: number | null; models: string[] | null; readOnlyAllowed: boolean };
type Show = { types: string[]; chains: Record<string, string[]>; providers: Prov[]; maxSlots: number; canUndo: boolean; configuredTotal: number; effective: { configured: number; effective: number; configEffective: number; laptopCap: number | null; reasons: string[]; source: string } };
type Models = { loading?: boolean; list?: { id: string; label: string }[]; known?: boolean; error?: string };
const ADD = "__add__";
const OFF = "off";
const move = (a: string[], i: number, d: number) => { const b = [...a]; const [x] = b.splice(i, 1); b.splice(i + d, 0, x); return b; };

export function RoutingScreen() {
  const rpc = useRpc(routingRpc);
  const rpcRef = useRef(rpc); rpcRef.current = rpc;
  const call = useCallback(async (input: Parameters<typeof rpc>[0]) => {
    let t: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([rpcRef.current(input), new Promise<never>((_, no) => { t = setTimeout(() => no(new Error(R.timedOut)), 100_000); })]); }
    catch (e: any) { return { error: String(e?.message ?? e) } as any; }
    finally { clearTimeout(t); }
  }, []);
  const [data, setData] = useState<Show | null>(null);
  const [models, setModels] = useState<Record<string, Models>>({});
  const [slots, setSlots] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [openModels, setOpenModels] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string; where: string } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const d: any = await call({ verb: "show" });
    if (d.error) { setLoadErr(d.error); return undefined; }
    setLoadErr(null); setData(d); setSlots(Object.fromEntries(d.providers.map((p: Prov) => [p.id, p.slots == null ? "" : String(p.slots)])));
    return d as Show;
  }, [call]);
  const loadModels = useCallback(async (id: string) => {
    setModels((m) => ({ ...m, [id]: { loading: true } }));
    const r: any = await call({ verb: "models", args: { provider: id } });
    setModels((m) => ({ ...m, [id]: r.error ? { error: r.error } : { list: r.models ?? [], known: !!r.known } }));
  }, [call]);
  useEffect(() => { void refresh().then((d) => { d?.providers.forEach((p) => void loadModels(p.id)); }); }, [refresh, loadModels]);

  const save = async (verb: "set" | "undo", args: Record<string, unknown> = {}, ok: string = R.saved, where = "top") => {
    setBusy(true); setMsg(null);
    const r: any = await call({ verb, args });
    setBusy(false);
    setMsg(r.error ? { ok: false, text: String(r.error), where } : { ok: true, text: r.saved === false ? R.nothing : ok, where });
    await refresh();
  };
  const setProv = (id: string, c: Record<string, unknown>) => save("set", { providers: { [id]: c } }, R.saved, id);
  const setChain = (t: string, chain: string[]) => save("set", { chains: { [t]: chain } }, R.saved, `chain:${t}`);
  // The answer appears in the card the user just used, not at the top of a long page.
  const note = (where: string) => (msg && msg.where === where ? <SettingsRow label={msg.ok ? msg.text : R.failed} error={msg.ok ? null : msg.text} /> : null);

  if (loadErr) return <SettingsSection title={R.title}><SettingsCard><SettingsRow label={R.loadFailed} error={loadErr} /><SettingsAction label={R.title} actionLabel={R.retry} onPress={() => void refresh()} /></SettingsCard></SettingsSection>;
  if (!data) return <SettingsSection title={R.title}><SettingsCard><SettingsRow label={R.loading} /></SettingsCard></SettingsSection>;

  const toggleModel = (p: Prov, id: string, on: boolean) => {
    const all = (models[p.id]?.list ?? []).map((m) => m.id);
    const cur = p.models ?? all;
    const next = on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
    if (!next.length) { setMsg({ ok: false, text: R.lastModel, where: p.id }); return; }
    void setProv(p.id, { models: all.every((x) => next.includes(x)) ? "all" : next });
  };
  const usedIds = new Set(Object.values(data.chains).flat().map((e) => e.split("/")[0]));
  // A provider that is off or not installed, with no slots, models or chain entry, is noise here: it is hidden and counted below (Settings > Providers switches it on).
  const shown = data.providers.filter((p) => (p.enabled && p.status !== "unavailable") || p.slots != null || p.models || usedIds.has(p.id));
  const hidden = data.providers.length - shown.length;
  const pretty = (p: Prov) => (p.label.toLowerCase() === p.id.toLowerCase() ? p.label : `${p.label} (${p.id})`);
  const addOptions = (t: string) => {
    const inChain = new Set(data.chains[t]);
    const opts: { label: string; value: string }[] = [{ label: R.addEntry, value: ADD }];
    for (const p of shown) {
      const ids = (models[p.id]?.list ?? []).map((m) => m.id).filter((id) => !p.models || p.models.includes(id));
      for (const e of [p.id, ...ids.map((id) => `${p.id}/${id}`)]) if (!inChain.has(e)) opts.push({ label: e, value: e });
    }
    return opts;
  };
  const eff = data.effective;

  return (
    <>
      <SettingsSection title={R.title}>
        <SettingsCard>
          <SettingsRow label={R.intro} />
          <SettingsRow label={R.total(data.configuredTotal)} hint={R.effective(eff.effective, eff.laptopCap, eff.configEffective)} />
          {eff.reasons.map((x) => <SettingsRow key={x} label={x} />)}
          {note("top")}
          <SettingsAction label={R.undoLabel} hint={data.canUndo ? undefined : R.nothingToUndo} actionLabel={R.undo} disabled={busy || !data.canUndo} onPress={() => void save("undo", {}, R.undone)} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={R.providers}>
        {data.providers.length === 0 ? <SettingsCard><SettingsRow label={R.noProviders} /></SettingsCard> : null}
        {shown.map((p) => {
          const m = models[p.id] ?? {};
          return (
            <SettingsCard key={p.id}>
              <SettingsSwitch label={pretty(p)} value={p.enabled} disabled={busy} onValueChange={(v) => void setProv(p.id, { enabled: v })} />
              <SettingsRow label={R.status} hint={`${R.statusWord(p.status)}${p.readOnlyAllowed ? `  -  ${R.readOnly}` : ""}`} />
              <SettingsInput label={R.slots(data.maxSlots)} hint={p.slots == null ? R.unlimited : undefined} initialValue={slots[p.id] ?? ""} onChangeText={(t) => setSlots((s) => ({ ...s, [p.id]: t }))} />
              <SettingsAction label={R.slotsAction} actionLabel={R.saveSlots} disabled={busy || (slots[p.id] ?? "") === (p.slots == null ? "" : String(p.slots))} onPress={() => void setProv(p.id, { slots: (slots[p.id] ?? "").trim() })} />
              <SettingsRow label={R.cap(p.cap)} />
              {m.known && !m.error ? (
                <SettingsAction label={R.models} hint={p.models ? R.someModels(p.models.length, m.list!.length) : R.allModels} actionLabel={openModels[p.id] ? R.hideList : R.showList(m.list!.length)} onPress={() => setOpenModels((o) => ({ ...o, [p.id]: !o[p.id] }))} />
              ) : <SettingsRow label={R.models} hint={m.loading ? R.loading : m.error ? undefined : R.noList} />}
              {m.error ? <SettingsRow label={R.modelsFailed} error={m.error} /> : null}
              {m.error ? <SettingsAction label={R.modelsFailed} actionLabel={R.retry} onPress={() => void loadModels(p.id)} /> : null}
              {m.known && openModels[p.id] ? m.list!.map((x) => (
                <SettingsSwitch key={x.id} label={x.label && x.label !== x.id ? `${x.label} (${x.id})` : x.id} value={!p.models || p.models.includes(x.id)} disabled={busy} onValueChange={(v) => toggleModel(p, x.id, v)} />
              )) : null}
              {m.known && p.models ? <SettingsAction label={R.useAllLabel} actionLabel={R.useAll} disabled={busy} onPress={() => void setProv(p.id, { models: "all" })} /> : null}
              {p.models ? <SettingsRow label={R.restricted(p.models.join(", "))} /> : null}
              {note(p.id)}
            </SettingsCard>
          );
        })}
        {hidden > 0 ? <SettingsCard><SettingsRow label={R.hidden(hidden)} /></SettingsCard> : null}
      </SettingsSection>
      {data.types.map((t) => {
        const chain = data.chains[t] ?? [];
        return (
          <SettingsSection key={t} title={R.chainTitle(t)}>
            <SettingsCard>
              {chain.length === 0 ? <SettingsRow label={R.emptyChain} /> : null}
              {chain.map((e, i) => (
                <SettingsSelect key={e} label={e} value={String(i + 1)} disabled={busy}
                  options={[...chain.map((_, j) => ({ label: R.position(j + 1) + (j === i ? ` (${R.current})` : ""), value: String(j + 1) })), { label: R.off, value: OFF }]}
                  onValueChange={(v) => { if (v === OFF) void setChain(t, chain.filter((x) => x !== e)); else if (Number(v) !== i + 1) void setChain(t, move(chain, i, Number(v) - 1 - i)); }} />
              ))}
              <SettingsSelect label={R.addLabel} value={ADD} options={addOptions(t)} onValueChange={(v) => { if (v !== ADD) void setChain(t, [...chain, v]); }} />
              {note(`chain:${t}`)}
            </SettingsCard>
          </SettingsSection>
        );
      })}
    </>
  );
}
