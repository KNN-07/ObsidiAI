import type { App, PluginManifest } from 'obsidian';

export type PluginAction = 'install' | 'update' | 'enable' | 'disable' | 'uninstall';
export interface PluginObservedState { installed: boolean; version: string | null; configuredEnabled: boolean; loaded: boolean }
export interface PluginRelease { repo: string; manifest: PluginManifest; targetVersion: string; olderCompatible: boolean; source: string }
export interface PluginChangeProposal {
  readonly action: PluginAction;
  readonly id: string;
  readonly name: string;
  readonly observed: Readonly<PluginObservedState>;
  readonly release: Readonly<PluginRelease> | null;
  readonly repo: string | null;
  readonly targetVersion: string | null;
  readonly effects: readonly string[];
}
export class PluginPolicyError extends Error {}
export function validatePluginId(id: string): string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9](?:[a-zA-Z0-9_-]|\.(?=[a-zA-Z0-9]))*$/.test(id) || id.length > 200 || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new PluginPolicyError('Invalid community plugin ID');
  return id;
}
type NativeManager = {
  manifests: Record<string, PluginManifest>;
  enabledPlugins: Set<string>;
  plugins: Record<string, unknown>;
  isEnabled(): boolean;
  installPlugin(repo: string, version: string, manifest: PluginManifest): Promise<void>;
  loadManifests(): Promise<void>;
  enablePlugin(id: string): Promise<void>;
  enablePluginAndSave(id: string): Promise<void>;
  disablePluginAndSave(id: string): Promise<void>;
  uninstallPlugin(id: string): Promise<void>;
};
export type NativeMethod = Exclude<keyof NativeManager, 'manifests' | 'enabledPlugins' | 'plugins'>;
const methods: NativeMethod[] = ['isEnabled', 'installPlugin', 'loadManifests', 'enablePlugin', 'enablePluginAndSave', 'disablePluginAndSave', 'uninstallPlugin'];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function safeManifest(value: PluginManifest): PluginManifest {
  return { id: value.id, name: value.name, author: value.author, description: value.description, version: value.version, minAppVersion: value.minAppVersion, ...(typeof value.isDesktopOnly === 'boolean' ? { isDesktopOnly: value.isDesktopOnly } : {}) };
}
/** The only access to the version-sensitive native community manager. */
export class PluginBridge {
  constructor(private readonly app: App) {}
  private manager(): Partial<NativeManager> {
    const value = 'plugins' in this.app ? this.app.plugins : undefined;
    if (!record(value)) throw new PluginPolicyError('Plugin management is unavailable on this Obsidian version: manager');
    return value as Partial<NativeManager>;
  }
  private state(): NativeManager {
    const manager = this.manager();
    if (!record(manager.manifests) || !record(manager.plugins) || !(manager.enabledPlugins instanceof Set)) throw new PluginPolicyError('Plugin management is unavailable on this Obsidian version: inspection maps');
    return manager as NativeManager;
  }
  compatibilityStatus(): { inspection: boolean; mutation: boolean; missing: string[]; message: string } {
    try {
      this.state();
      const manager = this.manager();
      const missing = methods.filter(method => typeof manager[method] !== 'function');
      return { inspection: true, mutation: missing.length === 0, missing, message: missing.length ? `Plugin management is unavailable on this Obsidian version: ${missing.join(', ')}` : 'Private native plugin manager available; lifecycle effects remain host/version-dependent.' };
    } catch { return { inspection: false, mutation: false, missing: ['inspection maps'], message: 'Plugin management is unavailable on this Obsidian version: inspection maps' }; }
  }
  manifest(id: string): PluginManifest | null {
    const map = this.state().manifests;
    return Object.hasOwn(map, id) ? safeManifest(map[id]!) : null;
  }
  ids(): string[] { return Object.keys(this.state().manifests).filter(id => { try { validatePluginId(id); return true; } catch { return false; } }).sort(); }
  observe(id: string): PluginObservedState {
    const manager = this.state();
    const manifest = this.manifest(id);
    return { installed: manifest !== null, version: manifest?.version ?? null, configuredEnabled: manager.enabledPlugins.has(id), loaded: Object.hasOwn(manager.plugins, id) && !!manager.plugins[id] };
  }
  requireMutation(required: NativeMethod[]): void {
    this.state();
    const manager = this.manager();
    for (const method of ['isEnabled', ...required] as NativeMethod[]) if (typeof manager[method] !== 'function') throw new PluginPolicyError(`Plugin management is unavailable on this Obsidian version: ${method}`);
    if (!manager.isEnabled!.call(manager)) throw new PluginPolicyError('Community plugins are restricted; review Community plugins settings yourself.');
  }
  async invoke<K extends Exclude<NativeMethod, 'isEnabled'>>(method: K, ...args: Parameters<NativeManager[K]>): Promise<void> {
    const manager = this.manager();
    const fn = manager[method];
    if (typeof fn !== 'function') throw new PluginPolicyError(`Plugin management is unavailable on this Obsidian version: ${method}`);
    await (fn as (...values: Parameters<NativeManager[K]>) => Promise<void>).apply(manager, args);
  }
}
export function pluginCompatibilityStatus(app: App) { return new PluginBridge(app).compatibilityStatus(); }
