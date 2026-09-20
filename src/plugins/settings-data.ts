import { PluginPolicyError } from './bridge';
import { MAX_SETTINGS_BYTES, MAX_SETTINGS_FIELDS, MAX_SETTING_VALUE_CHARS, type SettingsJson, type SettingsField, type SettingsEdit, type SettingsDiff } from './settings-types';

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const plain = (value: unknown): value is Record<string, SettingsJson> => !!value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) && !Array.isArray(value);
function fail(): never { throw new PluginPolicyError('Settings must be bounded JSON with no unsafe keys or values.'); }
function validateJson(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 100) fail();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); return; }
  if (typeof value !== 'object' || (!Array.isArray(value) && !plain(value)) || ancestors.has(value)) fail();
  ancestors.add(value);
  if (Object.getOwnPropertySymbols(value).length) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value) && Object.keys(value).length !== value.length) fail();
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (forbidden.has(key) || !descriptor.enumerable || !('value' in descriptor) || (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key))) fail();
    validateJson(descriptor.value, ancestors, depth + 1);
  }
  ancestors.delete(value);
}
export function parseSettings(bytes: string): Record<string, SettingsJson> {
  if (Buffer.byteLength(bytes, 'utf8') > MAX_SETTINGS_BYTES) throw new PluginPolicyError('Settings file exceeds the 256 KiB limit.');
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { throw new PluginPolicyError('Settings file is not valid JSON.'); }
  validateJson(value);
  if (!plain(value)) throw new PluginPolicyError('Settings file must contain a JSON object.');
  return value;
}
const escape = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
function pointer(path: string): string[] {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_SETTING_VALUE_CHARS) throw new PluginPolicyError('Invalid settings JSON pointer.');
  const segments = path.slice(1).split('/');
  if (segments.some(key => /~(?:[^01]|$)/.test(key))) throw new PluginPolicyError('Invalid settings JSON pointer.');
  const decoded = segments.map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (decoded.some(key => forbidden.has(key))) throw new PluginPolicyError('Unsafe settings JSON pointer.');
  return decoded;
}
export function fieldsOf(data: Record<string, SettingsJson>): readonly SettingsField[] {
  const fields: SettingsField[] = [];
  function visit(value: SettingsJson, path: string) {
    if (path.length > MAX_SETTING_VALUE_CHARS) throw new PluginPolicyError('Settings path exceeds the review limit.');
    if (plain(value) && Object.keys(value).length) { for (const key of Object.keys(value)) visit(value[key]!, `${path}/${escape(key)}`); return; }
    const valueJson = JSON.stringify(value);
    fields.push(Object.freeze({ path, valueJson, selectable: valueJson.length <= MAX_SETTING_VALUE_CHARS }));
    if (fields.length > MAX_SETTINGS_FIELDS) throw new PluginPolicyError('Settings file exceeds the 500-field review limit.');
  }
  for (const key of Object.keys(data)) visit(data[key]!, `/${escape(key)}`);
  return Object.freeze(fields);
}
export function patchSettings(bytes: string, edits: readonly SettingsEdit[], disclosed: ReadonlySet<string>) {
  if (!Array.isArray(edits) || !edits.length || edits.length > 20) throw new PluginPolicyError('Provide between 1 and 20 settings changes.');
  validateJson(edits);
  const data = parseSettings(bytes);
  const paths = edits.map(edit => pointer(edit.path));
  const diffs: SettingsDiff[] = [];
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!; const parts = paths[i]!;
    if (!plain(edit) || typeof edit.path !== 'string' || (edit.operation !== 'set' && edit.operation !== 'remove') || Object.keys(edit).some(key => !['operation', 'path', 'value'].includes(key))) throw new PluginPolicyError('Invalid settings change.');
    if (paths.some((other, j) => j !== i && other.slice(0, Math.min(other.length, parts.length)).every((part, k) => part === parts[k]))) throw new PluginPolicyError('Settings changes must not overlap.');
    let parent = data;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(parent, part) || !plain(parent[part])) throw new PluginPolicyError('Settings change requires an existing object parent; array indexes are not editable.');
      parent = parent[part] as Record<string, SettingsJson>;
    }
    const key = parts.at(-1)!; const exists = Object.hasOwn(parent, key);
    if (exists && (!disclosed.has(edit.path) || (plain(parent[key]) && Object.keys(parent[key]).length > 0))) throw new PluginPolicyError('Existing settings changes require a disclosed leaf field.');
    if (edit.operation === 'remove' && (!exists || Object.hasOwn(edit, 'value'))) throw new PluginPolicyError('Removal requires an existing disclosed field and no value.');
    if (edit.operation === 'set' && !Object.hasOwn(edit, 'value')) throw new PluginPolicyError('Setting a field requires a JSON value.');
    const after = edit.operation === 'set' ? JSON.stringify(edit.value) : '(removed)';
    if (after.length > MAX_SETTING_VALUE_CHARS) throw new PluginPolicyError('Proposed setting exceeds the value review limit.');
    diffs.push(Object.freeze({ operation: edit.operation, path: edit.path, before: exists ? JSON.stringify(parent[key]) : '(absent)', after }));
    if (edit.operation === 'remove') delete parent[key]; else parent[key] = edit.value!;
  }
  const after = `${JSON.stringify(data, null, 2)}\n`;
  parseSettings(after); fieldsOf(data);
  return { after, diffs: Object.freeze(diffs) };
}
