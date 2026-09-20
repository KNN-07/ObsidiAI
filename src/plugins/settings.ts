import type { App } from 'obsidian';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { ApprovalController } from '../ui/approval';
import { PluginBridge, PluginPolicyError, validatePluginId, type NativeMethod, type PluginObservedState } from './bridge';
import { fieldsOf, parseSettings, patchSettings } from './settings-data';
import { MAX_SETTINGS_BYTES, MAX_SHARED_SETTINGS_CHARS, type SettingsEdit, type PluginSettingsReadProposal } from './settings-types';

interface Receipt { revision: string; bytes: string; observed: PluginObservedState; manifest: string; identity: unknown; disclosed: ReadonlySet<string> }
export interface SettingsResult {
  outcome: 'applied' | 'unchanged' | 'rejected' | 'cancelled' | 'failed'; pluginId: string;
  persisted: boolean; partial: boolean; observed: PluginObservedState | null; message?: string;
}
const same = (a: PluginObservedState, b: PluginObservedState) => a.installed === b.installed && a.version === b.version && a.loaded === b.loaded && a.configuredEnabled === b.configuredEnabled;
export class PluginSettingsService {
  readonly tools: AgentTool<any>[];
  private readonly receipts = new Map<string, Receipt>();
  private disposed = false;
  constructor(private readonly app: App, private readonly selfId: string, private readonly bridge: PluginBridge,
    private readonly approval: Pick<ApprovalController, 'request'>,
    private readonly enqueue: <T>(action: () => Promise<T>) => Promise<T>, private readonly signal: (signal?: AbortSignal) => AbortSignal) {
    this.tools = [
      { name: 'inspect_plugin_settings', label: 'Review plugin settings disclosure', description: 'Ask the user which saved community-plugin JSON values may be sent to the model. No values are shared without selection and approval.', parameters: Type.Object({ pluginId: Type.String() }), executionMode: 'sequential', execute: async (_id, params: { pluginId: string }, signal) => {
        const details = await this.inspectSettings(params.pluginId, signal);
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      } },
      { name: 'propose_plugin_settings_change', label: 'Review plugin settings change', description: 'Propose exact JSON pointer changes to disclosed leaf fields or new keys under existing objects. Requires the inspection revision and explicit write/restart approval; schemas are not inferred.', parameters: Type.Object({ pluginId: Type.String(), revision: Type.String(), changes: Type.Array(Type.Object({ operation: Type.Union([Type.Literal('set'), Type.Literal('remove')]), path: Type.String(), value: Type.Optional(Type.Any()) }), { minItems: 1, maxItems: 20 }) }), executionMode: 'sequential', execute: async (_id, params: { pluginId: string; revision: string; changes: SettingsEdit[] }, signal) => {
        const details = await this.proposeSettingsChange(params.pluginId, params.revision, params.changes, signal);
        if (details.outcome === 'failed') throw new PluginPolicyError(JSON.stringify(details));
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      } },
    ] as AgentTool<any>[];
  }
  dispose(): void { this.disposed = true; this.receipts.clear(); }
  private check(signal: AbortSignal): void { if (this.disposed || signal.aborted) throw new PluginPolicyError('Settings operation cancelled.'); }
  private target(id: string) {
    validatePluginId(id);
    if (id === this.selfId) throw new PluginPolicyError('ObsidiAI cannot inspect or change its own settings.');
    const manifest = this.bridge.manifest(id);
    if (!manifest) throw new PluginPolicyError('An installed community plugin is required.');
    return manifest;
  }
  private path(id: string): string {
    const root = this.app.vault.configDir;
    if (!root || root.startsWith('/') || root.includes('\\') || root.includes(':') || root.split('/').some(part => !part || part === '.' || part === '..' || /[\x00-\x1f]/.test(part))) throw new PluginPolicyError('The vault configuration directory is unavailable.');
    return `${root}/plugins/${id}/data.json`;
  }
  private async readBytes(path: string): Promise<string> {
    const adapter = this.app.vault.adapter;
    try {
      const stat = await adapter.stat(path);
      if (!stat || stat.type !== 'file') throw new PluginPolicyError('Settings data.json is missing; the plugin must save its settings first.');
      if (stat.size > MAX_SETTINGS_BYTES) throw new PluginPolicyError('Settings file exceeds the 256 KiB limit.');
      const bytes = await adapter.read(path); parseSettings(bytes); return bytes;
    } catch (error) { if (error instanceof PluginPolicyError) throw error; throw new PluginPolicyError('Could not read the saved plugin settings.'); }
  }
  private matches(id: string, receipt: Receipt): boolean {
    return JSON.stringify(this.bridge.manifest(id)) === receipt.manifest && same(this.bridge.observe(id), receipt.observed) && this.bridge.instanceIdentity(id) === receipt.identity;
  }
  inspectSettings(pluginId: string, signal?: AbortSignal) {
    const active = this.signal(signal);
    return this.enqueue(async () => {
      this.check(active);
      const manifest = this.target(pluginId); const path = this.path(pluginId);
      const receipt: Receipt = { revision: crypto.randomUUID(), bytes: '', manifest: JSON.stringify(manifest), observed: this.bridge.observe(pluginId), identity: this.bridge.instanceIdentity(pluginId), disclosed: new Set() };
      receipt.bytes = await this.readBytes(path); this.check(active);
      if (!this.matches(pluginId, receipt)) throw new PluginPolicyError('Plugin changed since review; inspect it again.');
      const fields = fieldsOf(parseSettings(receipt.bytes));
      let selected = new Set<string>(); let accepting = true;
      const proposal: PluginSettingsReadProposal = Object.freeze({ kind: 'plugin-settings-read', pluginId, name: manifest.name, version: manifest.version, fields,
        select: (paths: readonly string[]) => {
          if (!accepting || active.aborted || this.disposed) return;
          if (!Array.isArray(paths)) throw new PluginPolicyError('Invalid settings selection.');
          const next = new Set(paths);
          let size = 0;
          for (const path of next) { const field = fields.find(field => field.path === path); if (!field?.selectable) throw new PluginPolicyError('Invalid settings selection.'); size += JSON.stringify({ path, value: JSON.parse(field.valueJson) }).length; }
          if (size > MAX_SHARED_SETTINGS_CHARS) throw new PluginPolicyError('Selected settings exceed the sharing limit.');
          selected = next;
        },
      });
      let decision: 'approve' | 'reject';
      try { decision = await this.approval.request(proposal, active); } finally { accepting = false; }
      if (active.aborted || this.disposed) return { outcome: 'cancelled' as const, pluginId };
      if (decision !== 'approve') return { outcome: 'rejected' as const, pluginId };
      if (await this.readBytes(path) !== receipt.bytes || !this.matches(pluginId, receipt)) throw new PluginPolicyError('Settings or plugin changed since review; inspect it again.');
      this.check(active);
      receipt.disclosed = new Set(selected); this.receipts.set(pluginId, receipt);
      return { outcome: 'shared' as const, pluginId, revision: receipt.revision, fields: fields.filter(field => selected.has(field.path)).map(field => ({ path: field.path, value: JSON.parse(field.valueJson) })), omittedCount: fields.length - selected.size };
    });
  }
  proposeSettingsChange(pluginId: string, revision: string, changes: readonly SettingsEdit[], signal?: AbortSignal): Promise<SettingsResult> {
    const active = this.signal(signal);
    return this.enqueue(async () => {
      let started = false; let persisted = false; let stopped = false; let restorationAttempted = false; let disableAttempted = false; let intendedBytes: string | undefined; let receipt: Receipt | undefined;
      const finish = (outcome: SettingsResult['outcome'], message?: string): SettingsResult => {
        let observed: PluginObservedState | null = null;
        try { observed = this.bridge.observe(pluginId); } catch { /* State may be unavailable after a native failure. */ }
        return { outcome, pluginId, persisted, partial: started && (outcome === 'failed' || !observed), observed, ...(message ? { message } : {}) };
      };
      const restore = async () => {
        if (!receipt || !stopped) return;
        const state = this.bridge.observe(pluginId);
        if (JSON.stringify(this.bridge.manifest(pluginId)) !== receipt.manifest || state.loaded || state.configuredEnabled || this.bridge.instanceIdentity(pluginId) != null) throw new PluginPolicyError('Plugin changed during restoration; its state was left untouched.');
        restorationAttempted = true;
        stopped = false;
        if (receipt.observed.configuredEnabled) await this.bridge.invoke('enablePluginAndSave', pluginId);
        else if (receipt.observed.loaded) await this.bridge.invoke('enablePlugin', pluginId);
        if (!same(this.bridge.observe(pluginId), { ...receipt.observed, loaded: receipt.observed.loaded || receipt.observed.configuredEnabled })) throw new PluginPolicyError('The approved plugin runtime state could not be restored.');
      };
      try {
        this.check(active); const manifest = this.target(pluginId); const path = this.path(pluginId);
        receipt = this.receipts.get(pluginId);
        if (!receipt || receipt.revision !== revision) throw new PluginPolicyError('Inspect and approve settings disclosure before proposing a change.');
        const { after, diffs } = patchSettings(receipt.bytes, changes, receipt.disclosed);
        intendedBytes = after;
        if (!this.matches(pluginId, receipt) || await this.readBytes(path) !== receipt.bytes || !this.matches(pluginId, receipt)) throw new PluginPolicyError('Settings or plugin changed since review; inspect it again.');
        if (JSON.stringify(parseSettings(after)) === JSON.stringify(parseSettings(receipt.bytes))) return finish('unchanged');
        const adapter = this.app.vault.adapter;
        if (typeof adapter.process !== 'function') throw new PluginPolicyError('Atomic plugin settings writes are unavailable on this Obsidian version.');
        const restart = receipt.observed.loaded || receipt.observed.configuredEnabled;
        const methods: NativeMethod[] = restart ? ['disablePluginAndSave', ...(receipt.observed.configuredEnabled ? ['enablePluginAndSave' as const] : ['enablePlugin' as const])] : [];
        this.bridge.requireMutation(methods); this.check(active);
        const decision = await this.approval.request(Object.freeze({ kind: 'plugin-settings-change', pluginId, name: manifest.name, version: manifest.version, observed: Object.freeze({ ...receipt.observed }), changes: diffs }), active);
        if (active.aborted || this.disposed) return finish('cancelled');
        if (decision !== 'approve') return finish('rejected');
        if (!this.matches(pluginId, receipt) || await this.readBytes(path) !== receipt.bytes || !this.matches(pluginId, receipt)) throw new PluginPolicyError('Settings or plugin changed since review; inspect it again.');
        this.bridge.requireMutation(methods); this.check(active);
        started = true; this.receipts.delete(pluginId);
        if (restart) {
          disableAttempted = true;
          await this.bridge.invoke('disablePluginAndSave', pluginId);
          const state = this.bridge.observe(pluginId);
          stopped = !state.loaded && !state.configuredEnabled && state.version === receipt.observed.version;
          if (!stopped || JSON.stringify(this.bridge.manifest(pluginId)) !== receipt.manifest) throw new PluginPolicyError('Plugin could not be stopped safely; settings were not written.');
          if (await this.readBytes(path) !== receipt.bytes) throw new PluginPolicyError('Plugin saved different settings while stopping; inspect it again. No patch was written.');
        }
        const expected = restart ? { ...receipt.observed, loaded: false, configuredEnabled: false } : receipt.observed;
        await adapter.process(path, current => {
          if (current !== receipt!.bytes || JSON.stringify(this.bridge.manifest(pluginId)) !== receipt!.manifest || !same(this.bridge.observe(pluginId), expected) || this.bridge.instanceIdentity(pluginId) !== (restart ? undefined : receipt!.identity)) throw new PluginPolicyError('Settings or plugin changed during commit; no patch was written.');
          return after;
        });
        persisted = await this.readBytes(path) === after;
        if (!persisted) throw new PluginPolicyError('Saved settings differ from the approved patch; inspect them again.');
        await restore();
        const restoredIdentity = this.bridge.instanceIdentity(pluginId);
        persisted = await this.readBytes(path) === after;
        if (!persisted) throw new PluginPolicyError('Plugin changed saved settings during restart; inspect them again.');
        if (JSON.stringify(this.bridge.manifest(pluginId)) !== receipt.manifest || this.bridge.instanceIdentity(pluginId) !== restoredIdentity || !same(this.bridge.observe(pluginId), { ...receipt.observed, loaded: receipt.observed.loaded || receipt.observed.configuredEnabled })) throw new PluginPolicyError('Plugin state changed after saving settings.');
        return finish('applied', 'Approved JSON persisted. Plugin-specific schema validity and effective runtime behavior are not guaranteed.');
      } catch (error) {
        let message = error instanceof PluginPolicyError ? error.message : 'Plugin settings operation failed; inspect the saved settings and plugin state.';
        if (disableAttempted && !restorationAttempted && receipt) {
          try {
            const state = this.bridge.observe(pluginId);
            stopped = !state.loaded && !state.configuredEnabled && JSON.stringify(this.bridge.manifest(pluginId)) === receipt.manifest && this.bridge.instanceIdentity(pluginId) == null;
          } catch { stopped = false; }
        }
        if (stopped) { try { await restore(); } catch { message += ' Prior plugin runtime state could not be restored safely.'; } }
        if (started && intendedBytes !== undefined) {
          try { persisted = await this.readBytes(this.path(pluginId)) === intendedBytes; } catch { persisted = false; }
        }
        return finish(!started && (active.aborted || this.disposed) ? 'cancelled' : 'failed', message);
      }
    });
  }
}
