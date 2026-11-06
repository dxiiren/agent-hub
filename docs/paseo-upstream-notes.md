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
