import type { PluginObservedState } from './bridge';

export type SettingsJson = null | boolean | number | string | SettingsJson[] | { [key: string]: SettingsJson };
export const MAX_SETTINGS_BYTES = 256 * 1024;
export const MAX_SETTINGS_FIELDS = 500;
export const MAX_SETTING_VALUE_CHARS = 16_000;
export const MAX_SHARED_SETTINGS_CHARS = 32_000;
export interface SettingsField { readonly path: string; readonly valueJson: string; readonly selectable: boolean }
export interface SettingsEdit { readonly operation: 'set' | 'remove'; readonly path: string; readonly value?: SettingsJson }
export interface SettingsDiff { readonly operation: 'set' | 'remove'; readonly path: string; readonly before: string; readonly after: string }
export type PluginSettingsReadProposal = Readonly<{
 kind: 'plugin-settings-read'; pluginId: string; name: string; version: string;
 fields: readonly SettingsField[];
 select: (paths: readonly string[]) => void;
}>;
export type PluginSettingsChangeProposal = Readonly<{
 kind: 'plugin-settings-change'; pluginId: string; name: string; version: string;
 observed: Readonly<PluginObservedState>; changes: readonly SettingsDiff[];
}>;
