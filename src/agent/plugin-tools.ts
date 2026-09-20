import { requireApiVersion, type App } from 'obsidian';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { ApprovalController } from '../ui/approval';
import { PluginBridge, PluginPolicyError, validatePluginId, type NativeMethod, type PluginAction, type PluginChangeProposal, type PluginObservedState, type PluginRelease } from '../plugins/bridge';
import { compareVersions, PluginRegistry } from '../plugins/registry';

export interface PluginChangeResult {
  outcome: 'applied' | 'unchanged' | 'rejected' | 'cancelled' | 'failed';
  action: PluginAction;
  pluginId: string;
  observed: PluginObservedState;
  partial: boolean;
  message?: string;
}
const pagination = { offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) };
function page<T>(items: T[], offset = 0, limit = 50) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new PluginPolicyError('Invalid pagination bounds');
  const nextOffset = offset + limit < items.length ? offset + limit : null;
  return { items: items.slice(offset, offset + limit), nextOffset, truncated: nextOffset !== null, total: items.length };
}
function result<T>(details: T) { return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details }; }
const same = (a: PluginObservedState, b: PluginObservedState) => a.installed === b.installed && a.version === b.version && a.configuredEnabled === b.configuredEnabled && a.loaded === b.loaded;

export class PluginLifecycleService {
  readonly tools: AgentTool<any>[];
  readonly bridge: PluginBridge;
  readonly registry = new PluginRegistry();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly lifetime = new AbortController();
  constructor(app: App, private readonly selfId: string, private readonly approval: Pick<ApprovalController, 'request'>) {
    this.bridge = new PluginBridge(app);
    this.tools = [
      { name: 'list_plugins', label: 'List installed community plugins', description: 'Inspect safe community plugin manifests, configured enabled intent and currently loaded state; no plugin settings or instances.', parameters: Type.Object(pagination), executionMode: 'sequential', execute: async (_id, args: { offset?: number; limit?: number }, signal) => {
        this.signal(signal).throwIfAborted();
        return result({ ...page(this.bridge.ids().map(id => ({ manifest: this.bridge.manifest(id), ...this.bridge.observe(id) })), args.offset, args.limit), mutationAvailability: this.bridge.compatibilityStatus() });
      } },
      { name: 'search_community_plugins', label: 'Search community plugins', description: 'Search the official community registry. Registry listing does not verify code safety.', parameters: Type.Object({ query: Type.String(), ...pagination }), executionMode: 'sequential', execute: async (_id, args: { query: string; offset?: number; limit?: number }, signal) => {
        const catalog = await this.registry.list(this.signal(signal)); const query = args.query.toLowerCase();
        return result({ ...page(catalog.entries.filter(entry => [entry.id, entry.name, entry.description, entry.author].some(value => value.toLowerCase().includes(query))), args.offset, args.limit), fetchedAt: catalog.fetchedAt });
      } },
      { name: 'get_plugin_details', label: 'Inspect community plugin', description: 'Inspect installed state and compatible exact-tag release provenance; offline installed details remain available.', parameters: Type.Object({ pluginId: Type.String() }), executionMode: 'sequential', execute: async (_id, args: { pluginId: string }, signal) => {
        const id = validatePluginId(args.pluginId); const activeSignal = this.signal(signal); activeSignal.throwIfAborted();
        const observed = this.bridge.observe(id); const manifest = this.bridge.manifest(id);
        try { return result({ pluginId: id, observed, manifest, release: await this.registry.resolve(id, activeSignal, false), mutationAvailability: this.bridge.compatibilityStatus() }); }
        catch (error) { if (!observed.installed || activeSignal.aborted) throw error; return result({ pluginId: id, observed, manifest, release: null, lookupError: error instanceof PluginPolicyError ? error.message : 'Release lookup unavailable', mutationAvailability: this.bridge.compatibilityStatus() }); }
      } },
      { name: 'propose_plugin_change', label: 'Propose community plugin change', description: 'Request individual native approval to install, update, enable, disable or uninstall a known community plugin. Native operations may execute third-party code; uninstall may delete settings. Never modifies this plugin itself.', parameters: Type.Object({ pluginId: Type.String(), action: Type.Union(['install', 'update', 'enable', 'disable', 'uninstall'].map(value => Type.Literal(value))) }), executionMode: 'sequential', execute: async (_id, args: { pluginId: string; action: PluginAction }, signal) => {
        const outcome = await this.proposeChange(args.pluginId, args.action, this.signal(signal));
        if (outcome.outcome === 'failed') throw new PluginPolicyError(JSON.stringify(outcome));
        return result(outcome);
      } },
    ] as AgentTool<any>[];
  }
  private signal(signal?: AbortSignal): AbortSignal { return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal; }
  dispose(): void { this.lifetime.abort(); this.registry.clear(); }
  compatibilityStatus() { return this.bridge.compatibilityStatus(); }
  proposeChange(pluginId: string, action: PluginAction, signal: AbortSignal): Promise<PluginChangeResult> {
    const activeSignal = this.signal(signal);
    const operation = this.queue.then(() => this.perform(pluginId, action, activeSignal));
    this.queue = operation.catch(() => {});
    return operation;
  }
  private async perform(id: string, action: PluginAction, signal: AbortSignal): Promise<PluginChangeResult> {
    validatePluginId(id);
    if (id === this.selfId) throw new PluginPolicyError('ObsidiAI cannot change itself');
    if (!['install', 'update', 'enable', 'disable', 'uninstall'].includes(action)) throw new PluginPolicyError('Invalid plugin action');
    const before = this.bridge.observe(id);
    let started = false;
    const finish = (outcome: PluginChangeResult['outcome'], message?: string): PluginChangeResult => {
      const observed = this.bridge.observe(id);
      return { outcome, action, pluginId: id, observed, partial: outcome === 'failed' && (started || !same(before, observed)), ...(message ? { message } : {}) };
    };
    try {
      signal.throwIfAborted();
      const installed = this.bridge.manifest(id);
      let release: PluginRelease | null = null;
      if (!installed && action !== 'install') {
        // An absent uninstall is a no-op only for a known registry ID, never a core/unknown ID.
        if (action !== 'uninstall' || !(await this.registry.list(signal, true)).entries.some(entry => entry.id === id)) throw new PluginPolicyError('Installed community plugin required');
        if (before.configuredEnabled || before.loaded) throw new PluginPolicyError('Plugin has residual native state; inspect it in Community plugins settings');
        return finish('unchanged');
      }
      if (action === 'install' && (before.installed || before.configuredEnabled || before.loaded)) throw new PluginPolicyError('Plugin already exists or has residual native state; use update for an installed plugin');
      if (action === 'install' || action === 'update') {
        release = await this.registry.resolve(id, signal, true);
        if (action === 'update' && compareVersions(release.targetVersion, before.version!) <= 0) return finish('unchanged', 'No newer compatible stable release is available; no downgrade performed.');
      }
      if (action === 'enable' && (!installed || !requireApiVersion(installed.minAppVersion))) throw new PluginPolicyError('Installed plugin is incompatible with this Obsidian version');
      if ((action === 'enable' && before.configuredEnabled && before.loaded) || (action === 'disable' && !before.configuredEnabled && !before.loaded)) return finish('unchanged');
      const required: NativeMethod[] = action === 'install' ? ['installPlugin', 'loadManifests', 'disablePluginAndSave'] : action === 'update' ? ['installPlugin', 'loadManifests', 'disablePluginAndSave', ...(before.configuredEnabled ? ['enablePluginAndSave' as const] : before.loaded ? ['enablePlugin' as const] : [])] : action === 'uninstall' ? ['uninstallPlugin', 'loadManifests', ...(before.configuredEnabled || before.loaded ? ['disablePluginAndSave' as const] : [])] : [action === 'enable' ? 'enablePluginAndSave' : 'disablePluginAndSave'];
      this.bridge.requireMutation(required);
      const effects = action === 'install' ? ['Install exact release assets through Obsidian; leave disabled. Enabling later requires separate approval. If native installation runs code, disable it and report that behavior.'] : action === 'update' ? [`Stop running code if enabled or loaded; replace assets; restore configured enabled intent (${before.configuredEnabled}) and loaded state (${before.configuredEnabled || before.loaded}). Configured-but-not-loaded plugins will be restarted.`] : action === 'enable' ? ['Enable and load third-party code; persist enabled intent.'] : action === 'disable' ? ['Stop loaded third-party code and persist disabled intent.'] : ["Stop loaded code; native uninstall may remove this plugin's files and saved settings; no backup is created."];
      const proposal: PluginChangeProposal = Object.freeze({ action, id, name: installed?.name ?? release!.manifest.name, observed: Object.freeze({ ...before }), release: release ? Object.freeze({ ...release, manifest: Object.freeze({ ...release.manifest }) }) : null, repo: release?.repo ?? null, targetVersion: release?.targetVersion ?? null, effects: Object.freeze(effects) });
      const decision = await this.approval.request({ kind: 'plugin-change', change: proposal }, signal);
      if (signal.aborted) return finish('cancelled');
      if (decision !== 'approve') return finish('rejected');
      if (!same(before, this.bridge.observe(id)) || JSON.stringify(installed) !== JSON.stringify(this.bridge.manifest(id))) throw new PluginPolicyError('Plugin changed since review; inspect it and request a new approval');
      if (release) {
        const current = await this.registry.resolve(id, signal, true);
        if (JSON.stringify(current) !== JSON.stringify(release)) throw new PluginPolicyError('Plugin changed since review; inspect it and request a new approval');
      }
      // Network revalidation yielded: check local state again immediately before committing.
      if (!same(before, this.bridge.observe(id)) || JSON.stringify(installed) !== JSON.stringify(this.bridge.manifest(id))) throw new PluginPolicyError('Plugin changed since review; inspect it and request a new approval');
      this.bridge.requireMutation(required);
      signal.throwIfAborted();
      started = true;
      let nativeInstallRanCode = false;
      if (action === 'install' || action === 'update') {
        if (action === 'update' && (before.configuredEnabled || before.loaded)) {
          await this.bridge.invoke('disablePluginAndSave', id);
          const stopped = this.bridge.observe(id);
          if (stopped.configuredEnabled || stopped.loaded) throw new PluginPolicyError('Native disable failed to stop the plugin; update halted');
        }
        await this.bridge.invoke('installPlugin', release!.repo, release!.targetVersion, { ...release!.manifest });
        await this.bridge.invoke('loadManifests');
        const afterInstall = this.bridge.observe(id);
        if (!afterInstall.installed || afterInstall.version !== release!.targetVersion) throw new PluginPolicyError('Native installation did not produce the approved version; restoration halted');
        if (action === 'install') {
          if (afterInstall.configuredEnabled || afterInstall.loaded) { nativeInstallRanCode = true; await this.bridge.invoke('disablePluginAndSave', id); }
        } else if (before.configuredEnabled) await this.bridge.invoke('enablePluginAndSave', id);
        else if (before.loaded) {
          if (afterInstall.configuredEnabled || afterInstall.loaded) await this.bridge.invoke('disablePluginAndSave', id);
          await this.bridge.invoke('enablePlugin', id);
        } else if (afterInstall.configuredEnabled || afterInstall.loaded) { nativeInstallRanCode = true; await this.bridge.invoke('disablePluginAndSave', id); }
        const expected = { installed: true, version: release!.targetVersion, configuredEnabled: action === 'update' && before.configuredEnabled, loaded: action === 'update' && (before.configuredEnabled || before.loaded) };
        if (!same(expected, this.bridge.observe(id))) throw new PluginPolicyError('Native plugin installation did not reach the approved version and enabled/loaded state');
      } else if (action === 'uninstall') {
        if (before.configuredEnabled || before.loaded) {
          await this.bridge.invoke('disablePluginAndSave', id);
          const stopped = this.bridge.observe(id);
          if (stopped.configuredEnabled || stopped.loaded) throw new PluginPolicyError('Native disable failed to stop the plugin; uninstall halted');
        }
        await this.bridge.invoke('uninstallPlugin', id);
        await this.bridge.invoke('loadManifests');
        if (!same({ installed: false, version: null, configuredEnabled: false, loaded: false }, this.bridge.observe(id))) throw new PluginPolicyError('Native uninstall left installed, configured, or loaded state; no filesystem cleanup attempted');
      } else {
        await this.bridge.invoke(action === 'enable' ? 'enablePluginAndSave' : 'disablePluginAndSave', id);
        if (!same({ ...before, configuredEnabled: action === 'enable', loaded: action === 'enable' }, this.bridge.observe(id))) throw new PluginPolicyError('Native plugin operation did not reach the requested enabled/loaded state');
      }
      return finish('applied', nativeInstallRanCode ? 'Native installation unexpectedly enabled or loaded code; restored the approved disabled state. Code may have executed.' : undefined);
    } catch (error) {
      if (!started && signal.aborted) return finish('cancelled');
      return finish('failed', error instanceof PluginPolicyError ? error.message : 'Native plugin operation failed; observed state is reported. No rollback was attempted.');
    }
  }
}
