# Paseo upstream notes: adding providers from the Providers page

Checked against Paseo 0.15.2 (`@getpaseo/server` web bundle and `@getpaseo/plugin` types).

## What a plugin can and cannot do

The plugin client API (`PluginClientContext`) offers: `addSettingsScreen`, `addScreen`, `addSidebarHeaderItem`, `addSidebarFooterItem`, `addAgentPanel`, `addWorkspacePanel`, `addCommandCenterItem`, `addSlashCommand`, `addHeaderButton` and `addComposerPill` (workspace and agent surfaces only), `addAttachmentSource`, `addTheme`, `addFilePanel`, timeline transformers and renderers. None of them targets the Settings > Providers page or its "Add provider" dialog.

In the web bundle, a plugin's `settingsScreens` are read in exactly two places: the row menu of the Plugins page (`PluginSettingsMenuItems`) and the route `/settings/hosts/<host>/plugins/<plugin>/<screen>`. The provider catalog dialog is built from the daemon's fixed ACP catalog, and its Add button writes the catalog entry as is (no URL, model or env field).

So without patching Paseo the form cannot live on the Providers page. This repo ships it as the Settings screen "Add provider (Agent Hub)" (Plugins > agent-hub-providers menu, or the command palette entry of the same name).

## Minimal upstream patch idea (not applied here)

Let a plugin attach a section to a built-in settings page:

1. Add `addSettingsSection({ page: "providers", id, title, Component })` to `PluginClientContext` (same shape as `addSettingsScreen` plus the target page).
2. In the Providers settings screen, render `installedPlugins.flatMap((p) => p.settingsSections.filter((s) => s.page === "providers"))` under the provider list, inside the same `PluginRpcProvider` that `addSettingsScreen` components already get.

That is about 20 lines in the web app and one type in `@getpaseo/plugin`. With it, `plugins/providers/index.client.tsx` would register the same `Screen` component as a Providers-page section and the Plugins-menu route could stay as a fallback.

## Usage panel: collapsible per-endpoint rows (not applied here)

Checked against Paseo 0.15.2. The `UsageReport` details schema is `{id, label, value, tone?}` only (`@getpaseo/plugin` `UsageDetail`, and the zod object in the web bundle); there is no group, children, section or collapsed field, and the card renders every detail row. So the self-hosted card (one per provider kind, `plugins/usage-otel/server/selfhosted-usage.mjs`) shows totals first and one plain row per endpoint.

Upstream patch idea: add an optional `group?: string` (or `children?: UsageDetail[]`) to `UsageDetail`, plus `collapsed?: boolean`; the usage card renders rows sharing a `group` under a header row with a chevron, collapsed by default. About 15 lines in the card component and the zod schema.

## Update: the Add provider list is baked into the web bundle (fork patch, and the upstream PR)

Evidence (0.15.2 web bundle, `ProvidersSection` / `ProviderCatalogList`): `useAcpProviderCatalog()` returns the constant `ACP_PROVIDER_CATALOG` (`useState(ACP_PROVIDER_CATALOG)`, `refetch` is `async () => s`), no daemon API serves it, so there is no data to extend from a plugin or the config. `rankProviderCatalog` scores only `[title, id]`. The Add button runs `patchConfig(buildAcpProviderConfigPatch(entry))`.

Fork patch (thin, applied by `just up`, version + sha256 checked, see `scripts/paseo-web-patch.mjs` and `patches/paseo-0.15.2/web-bundle.json`): four edits. (1) `useAcpProviderCatalog` also fetches `/agent-hub-catalog.json` (same origin, written next to the web UI) and appends valid entries; (2) the ranker also scores an optional `keywords` array; (3) the install handler of an entry that carries `agentHub: { kind, plugin, screen }` opens `/settings/hosts/<id>/plugins/<plugin>/<screen>?kind=<kind>` instead of writing config; (4) the tile hides the "Install instructions" link when the entry has none.

### Upstream PR description: plugin-extensible provider catalog

Title: Let plugins add entries to Settings > Providers > Add provider.

Problem: the Add provider list is a compile-time constant, so a plugin that adds a provider kind (a custom endpoint, a company agent) cannot be found where users look; its only surface is a Plugins settings screen.

Change: (a) `@getpaseo/plugin` gets `client.addProviderCatalogEntry({ id, title, keywords?, iconSvg?, onSelect(ctx) })`; (b) `useAcpProviderCatalog` merges the plugin entries after the built-in ones and `rankProviderCatalog` also scores `keywords`; (c) `onSelect` replaces the default config patch (a plugin can open its own settings screen, with `ctx.openSettings(screenId, { params })`, or run its own install flow); built-in entries are unchanged; (d) the tile omits the install link when `installLink` is absent. About 40 lines in the web app and one type in `@getpaseo/plugin`; no daemon or protocol change. Tests: catalog merge order and id collisions (built-in wins), ranking by keyword, `onSelect` called instead of `buildAcpProviderConfigPatch`, tile without `installLink`.

Why not a section on the page (the earlier idea above): the catalog entry gives the same discoverability with a smaller surface, and works for any plugin without layout decisions.

## Add custom model: a picker instead of a text box (fork patch rev 2, and the upstream PR)

Evidence (0.15.2 web bundle): the only place the Providers page takes a model id as text is the "Add custom model" sheet (`AddCustomModelSheet`, i18n keys `settings.providers.models.addCustomTitle` / `modelId` / `modelIdPlaceholder`). It writes `{id,label}` into `agents.providers.<id>.additionalModels` through `patchConfig`. The "N models" list above it comes from the daemon (`list_provider_models_request`, client `listProviderModels(provider)`), which for a custom ACP agent only knows the models that agent announces, so an OpenAI-compatible endpoint that serves more models than the one configured has no way to show them.

Fork patch (two more edits in `patches/paseo-0.15.2/web-bundle.json`, component source in `model-picker.js`, revision marker `agent-hub-rev:2`, re-applied automatically over an older revision): the sheet's text input is replaced by `__AhPick`, a select. Its list comes from (1) the plugin RPC `agent-hub-providers.call` verb `provider-models` (an endpoint provider: the daemon-side tool fetches `<base>/models` with the stored key, so the key never reaches the browser; a provider whose models the user names, such as a local model server, gets an empty list and the daemon is not asked, because asking would start it), else (2) the daemon's own `listProviderModels(provider)`, the same catalog the page already shows as "N models" (Claude, Codex, Qoder, OpenCode, Copilot, accounts of them). Models already in the list are left out. The last entry is "Custom model id...", which shows the original text input. A failed load shows the reason, a Retry button and the text input.

### Upstream PR description: model picker in Add custom model

Title: Offer the provider's own model list when adding a custom model.

Problem: adding a model asks for a free-text id even when the provider can list the ids it serves.

Change: (a) `@getpaseo/plugin` gets `client.addProviderModelSource({ provider | match, list(ctx) => Promise<{id,label?}[]> })` so a plugin that owns an endpoint kind can supply ids; (b) the sheet shows a select fed by the first matching plugin source, else `listProviderModels`, minus ids already present, with "Custom model id..." last; (c) load errors show a message and Retry. About 60 lines in the web app and one type; no daemon or protocol change. Tests: source precedence, de-duplication against `additionalModels`, error plus retry, custom entry reveals the text input.
