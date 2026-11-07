import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { routingRpc } from "../shared/rpc";
import { R } from "./routing-strings";

type Prov = { id: string; label: string; status: string | null; enabled: boolean; slots: number | null; models: string[] | null; readOnlyAllowed: boolean };
type Show = { types: string[]; chains: Record<string, string[]>; providers: Prov[]; maxSlots: number; canUndo: boolean; configuredTotal: number; effective: { configured: number; effective: number; reasons: string[]; source: string } };
type Models = { loading?: boolean; list?: { id: string; label: string }[]; known?: boolean; error?: string };
const ADD = "__add__";
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
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
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

  const save = async (verb: "set" | "undo", args: Record<string, unknown> = {}, ok: string = R.saved) => {
    setBusy(true); setMsg(null);
    const r: any = await call({ verb, args });
    setBusy(false);
    setMsg(r.error ? { ok: false, text: `${R.failed} ${r.error}` } : { ok: true, text: r.saved === false ? R.nothing : ok });
    await refresh();
  };
  const setProv = (id: string, c: Record<string, unknown>) => save("set", { providers: { [id]: c } });
  const setChain = (t: string, chain: string[]) => save("set", { chains: { [t]: chain } });

  if (loadErr) return <SettingsSection title={R.title}><SettingsCard><SettingsRow label={R.loadFailed} error={loadErr} /><SettingsAction label={R.title} actionLabel={R.retry} onPress={() => void refresh()} /></SettingsCard></SettingsSection>;
  if (!data) return <SettingsSection title={R.title}><SettingsCard><SettingsRow label={R.loading} /></SettingsCard></SettingsSection>;

  const toggleModel = (p: Prov, id: string, on: boolean) => {
    const all = (models[p.id]?.list ?? []).map((m) => m.id);
    const cur = p.models ?? all;
    const next = on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
    if (!next.length) { setMsg({ ok: false, text: R.lastModel }); return; }
    void setProv(p.id, { models: all.every((x) => next.includes(x)) ? "all" : next });
  };
  const addOptions = (t: string) => {
    const inChain = new Set(data.chains[t]);
    const opts: { label: string; value: string }[] = [{ label: R.addEntry, value: ADD }];
    for (const p of data.providers) {
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
          <SettingsRow label={R.total(data.configuredTotal)} hint={R.effective(eff.effective, eff.source)} />
          {eff.reasons.map((x) => <SettingsRow key={x} label={x} />)}
          {msg ? <SettingsRow label={msg.text} error={msg.ok ? null : msg.text} /> : null}
          <SettingsAction label={R.undoLabel} hint={data.canUndo ? undefined : R.nothingToUndo} actionLabel={R.undo} disabled={busy || !data.canUndo} onPress={() => void save("undo", {}, R.undone)} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={R.providers}>
        {data.providers.length === 0 ? <SettingsCard><SettingsRow label={R.noProviders} /></SettingsCard> : null}
        {data.providers.map((p) => {
          const m = models[p.id] ?? {};
          return (
            <SettingsCard key={p.id}>
              <SettingsSwitch label={`${p.label} (${p.id})`} value={p.enabled} disabled={busy} onValueChange={(v) => void setProv(p.id, { enabled: v })} />
              <SettingsRow label={R.status} hint={`${p.status ?? R.unknown}${p.readOnlyAllowed ? `  -  ${R.readOnly}` : ""}`} />
              <SettingsInput label={R.slots(data.maxSlots)} hint={p.slots == null ? R.unlimited : undefined} initialValue={slots[p.id] ?? ""} onChangeText={(t) => setSlots((s) => ({ ...s, [p.id]: t }))} />
              <SettingsAction label={p.id} actionLabel={R.saveSlots} disabled={busy || (slots[p.id] ?? "") === (p.slots == null ? "" : String(p.slots))} onPress={() => void setProv(p.id, { slots: (slots[p.id] ?? "").trim() })} />
              <SettingsRow label={R.models} hint={m.loading ? R.loading : m.error ? undefined : m.known ? (p.models ? R.someModels(p.models.length, m.list!.length) : R.allModels) : R.noList} />
              {m.error ? <SettingsRow label={R.modelsFailed} error={m.error} /> : null}
              {m.error ? <SettingsAction label={p.id} actionLabel={R.retry} onPress={() => void loadModels(p.id)} /> : null}
              {m.known ? m.list!.map((x) => (
                <SettingsSwitch key={x.id} label={x.label && x.label !== x.id ? `${x.label} (${x.id})` : x.id} value={!p.models || p.models.includes(x.id)} disabled={busy} onValueChange={(v) => toggleModel(p, x.id, v)} />
              )) : null}
              {m.known && p.models ? <SettingsAction label={p.id} actionLabel={R.useAll} disabled={busy} onPress={() => void setProv(p.id, { models: "all" })} /> : null}
              {p.models ? <SettingsRow label={R.restricted(p.models.join(", "))} /> : null}
            </SettingsCard>
          );
        })}
      </SettingsSection>
      {data.types.map((t) => {
        const chain = data.chains[t] ?? [];
        return (
          <SettingsSection key={t} title={R.chainTitle(t)}>
            <SettingsCard>
              {chain.length === 0 ? <SettingsRow label={R.emptyChain} /> : null}
              {chain.map((e, i) => (
                <SettingsRow key={e} label={`${i + 1}. ${e}`}>
                  <SettingsAction label={e} actionLabel={R.up} disabled={busy || i === 0} onPress={() => void setChain(t, move(chain, i, -1))} />
                  <SettingsAction label={e} actionLabel={R.down} disabled={busy || i === chain.length - 1} onPress={() => void setChain(t, move(chain, i, 1))} />
                  <SettingsAction label={e} actionLabel={R.off} disabled={busy} onPress={() => void setChain(t, chain.filter((x) => x !== e))} />
                </SettingsRow>
              ))}
              <SettingsSelect label={R.addEntry} value={ADD} options={addOptions(t)} onValueChange={(v) => { if (v !== ADD) void setChain(t, [...chain, v]); }} />
            </SettingsCard>
          </SettingsSection>
        );
      })}
    </>
  );
}
