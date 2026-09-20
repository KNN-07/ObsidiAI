import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, PluginManifest } from 'obsidian';
import type { PluginChangeProposal } from '../src/plugins/bridge';
vi.mock('obsidian', () => ({ requireApiVersion: (version: string) => /^\d+\.\d+\.\d+$/.test(version) && Number(version.split('.')[0]) <= 1 }));
vi.mock('../src/agent/node-fetch', () => ({ fetch: vi.fn() }));
import { fetch as nodeFetch } from '../src/agent/node-fetch';
import { PluginLifecycleService } from '../src/agent/plugin-tools';
import { PluginRegistry, validateRepository } from '../src/plugins/registry';

const manifest = (version = '1.0.0', minAppVersion = '1.0.0'): PluginManifest => ({ id: 'fixture', name: 'Fixture', author: 'Test', description: 'Harmless fixture', version, minAppVersion });
function setup(installed = false, enabled = false, loaded = false) {
  const manager = {
    manifests: installed ? { fixture: manifest() } as Record<string, PluginManifest> : {} as Record<string, PluginManifest>,
    enabledPlugins: new Set(enabled ? ['fixture'] : []),
    plugins: loaded ? { fixture: {} } as Record<string, unknown> : {} as Record<string, unknown>,
    isEnabled: vi.fn(() => true),
    installPlugin: vi.fn(async (_repo: string, _version: string, next: PluginManifest) => { manager.manifests.fixture = { ...next }; }),
    loadManifests: vi.fn(async () => {}),
    disablePluginAndSave: vi.fn(async (id: string) => { manager.enabledPlugins.delete(id); delete manager.plugins[id]; }),
    enablePluginAndSave: vi.fn(async (id: string) => { manager.enabledPlugins.add(id); manager.plugins[id] = {}; }),
    enablePlugin: vi.fn(async (id: string) => { manager.plugins[id] = {}; }),
    uninstallPlugin: vi.fn(async (id: string) => { delete manager.manifests[id]; }),
  };
  let decision: ((answer: 'approve' | 'reject') => void) | undefined;
  let proposed: PluginChangeProposal | undefined;
  const approval = { request: vi.fn(async (proposal: { kind: string; change?: PluginChangeProposal }, signal: AbortSignal) => {
    proposed = proposal.change;
    return new Promise<'approve' | 'reject'>(resolve => {
      let settled = false;
      decision = answer => { if (!settled) { settled = true; signal.removeEventListener('abort', cancel); resolve(answer); } };
      const cancel = () => decision?.('reject');
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }) };
  const service = new PluginLifecycleService({ plugins: manager } as unknown as App, 'obsidiai', approval);
  return { manager, service, approval, proposal: () => proposed, decide: (answer: 'approve' | 'reject') => decision!(answer) };
}
let target: PluginManifest;
beforeEach(() => {
  target = manifest('2.0.0');
  vi.mocked(nodeFetch).mockReset();
  vi.mocked(nodeFetch).mockImplementation(async input => {
    const url = String(input);
    const data = url.endsWith('community-plugins.json') ? [{ id: 'fixture', name: 'Fixture', description: 'Test', author: 'Test', repo: 'owner/fixture' }] : url.endsWith('versions.json') ? { '1.9.0': '1.0.0', '1.10.0': '1.0.0' } : url.includes('/releases/download/1.10.0/') ? manifest('1.10.0') : target;
    return new Response(JSON.stringify(data), { status: 200 });
  });
});
const waitReview = async (fixture: { proposal(): PluginChangeProposal | undefined }) => { await vi.waitFor(() => expect(fixture.proposal()).toBeDefined()); };

describe('approval-bound community lifecycle', () => {
  it('rejection and cancellation followed by a late approval leave installation absent', async () => {
    for (const abort of [false, true]) {
      const fixture = setup(); const controller = new AbortController();
      const pending = fixture.service.proposeChange('fixture', 'install', controller.signal);
      await waitReview(fixture);
      expect(fixture.manager.manifests).toEqual({});
      if (abort) controller.abort(); else fixture.decide('reject');
      fixture.decide('approve');
      expect((await pending).outcome).toBe(abort ? 'cancelled' : 'rejected');
      expect(fixture.manager.manifests).toEqual({});
      expect(fixture.manager.enabledPlugins.size).toBe(0);
      fixture.service.dispose();
    }
  });
  it('pins an approved installation, leaves it disabled, and requires a separate enable decision', async () => {
    const fixture = setup();
    const install = fixture.service.proposeChange('fixture', 'install', new AbortController().signal);
    await waitReview(fixture); fixture.decide('approve');
    expect(await install).toMatchObject({ outcome: 'applied', observed: { installed: true, version: '2.0.0', configuredEnabled: false, loaded: false } });
    const enable = fixture.service.proposeChange('fixture', 'enable', new AbortController().signal);
    await vi.waitFor(() => expect(fixture.proposal()?.action).toBe('enable'));
    fixture.decide('reject');
    expect(await enable).toMatchObject({ outcome: 'rejected', observed: { configuredEnabled: false, loaded: false } });
  });
  it('invalidates changed local state or fresh release metadata instead of installing', async () => {
    for (const change of ['local', 'release']) {
      const fixture = setup();
      const pending = fixture.service.proposeChange('fixture', 'install', new AbortController().signal);
      await waitReview(fixture);
      if (change === 'local') fixture.manager.manifests.fixture = manifest('1.5.0'); else target = manifest('3.0.0');
      fixture.decide('approve');
      expect(await pending).toMatchObject({ outcome: 'failed', message: 'Plugin changed since review; inspect it and request a new approval' });
      expect(fixture.manager.installPlugin).not.toHaveBeenCalled();
      target = manifest('2.0.0');
    }
  });
  it.each([[true, false], [false, true], [false, false]])('restores configured=%s loaded=%s update intent', async (enabled, loaded) => {
    const fixture = setup(true, enabled, loaded);
    const pending = fixture.service.proposeChange('fixture', 'update', new AbortController().signal);
    await waitReview(fixture); fixture.decide('approve');
    expect(await pending).toMatchObject({ outcome: 'applied', observed: { version: '2.0.0', configuredEnabled: enabled, loaded: enabled || loaded } });
  });
  it('reports partial native failure without claiming rollback', async () => {
    const fixture = setup(true, true, true);
    fixture.manager.installPlugin.mockRejectedValueOnce(new Error('unsafe upstream body'));
    const pending = fixture.service.proposeChange('fixture', 'update', new AbortController().signal);
    await waitReview(fixture); fixture.decide('approve');
    const outcome = await pending;
    expect(outcome).toMatchObject({ outcome: 'failed', partial: true, observed: { version: '1.0.0', configuredEnabled: false, loaded: false } });
    expect(outcome.message).not.toContain('unsafe upstream body');
  });
  it('settles started native work despite Stop and serializes subsequent requests', async () => {
    const fixture = setup(); let finishNative!: () => void;
    fixture.manager.installPlugin.mockImplementationOnce(async (_repo, _version, next) => { await new Promise<void>(resolve => { finishNative = resolve; }); fixture.manager.manifests.fixture = next; });
    const controller = new AbortController();
    const pending = fixture.service.proposeChange('fixture', 'install', controller.signal);
    await waitReview(fixture); fixture.decide('approve');
    await vi.waitFor(() => expect(finishNative).toBeDefined()); controller.abort();
    const next = fixture.service.proposeChange('fixture', 'enable', new AbortController().signal);
    expect(fixture.proposal()?.action).toBe('install');
    finishNative();
    expect(await pending).toMatchObject({ outcome: 'applied', observed: { installed: true, configuredEnabled: false, loaded: false } });
    await vi.waitFor(() => expect(fixture.proposal()?.action).toBe('enable')); fixture.decide('reject'); await next;
  });
  it('rejects self, unsafe and non-community IDs without native mutation', async () => {
    const fixture = setup();
    for (const id of ['obsidiai', '../fixture', 'https://example.org']) {
      await expect(fixture.service.proposeChange(id, 'enable', new AbortController().signal)).rejects.toThrow();
    }
    expect(await fixture.service.proposeChange('core-editor', 'enable', new AbortController().signal)).toMatchObject({ outcome: 'failed' });
    expect(fixture.manager.enablePluginAndSave).not.toHaveBeenCalled();
  });
  it('keeps incompatible plugins disableable and uninstallable but not enableable', async () => {
    const fixture = setup(true, true, true); fixture.manager.manifests.fixture = manifest('1.0.0', '9.0.0');
    expect(await fixture.service.proposeChange('fixture', 'enable', new AbortController().signal)).toMatchObject({ outcome: 'failed' });
    const disable = fixture.service.proposeChange('fixture', 'disable', new AbortController().signal);
    await waitReview(fixture); fixture.decide('approve'); expect((await disable).outcome).toBe('applied');
    const uninstall = fixture.service.proposeChange('fixture', 'uninstall', new AbortController().signal);
    await vi.waitFor(() => expect(fixture.proposal()?.action).toBe('uninstall'));
    expect(fixture.proposal()?.effects.join(' ')).toContain('saved settings');
    fixture.decide('reject'); expect((await uninstall).observed.installed).toBe(true);
    const approved = fixture.service.proposeChange('fixture', 'uninstall', new AbortController().signal);
    await vi.waitFor(() => expect(fixture.approval.request).toHaveBeenCalledTimes(3)); fixture.decide('approve');
    expect(await approved).toMatchObject({ outcome: 'applied', observed: { installed: false, configuredEnabled: false, loaded: false } });
  });
  it('keeps inspection available when a lifecycle capability is absent', async () => {
    const fixture = setup(true);
    Reflect.deleteProperty(fixture.manager, 'enablePluginAndSave');
    expect(fixture.service.compatibilityStatus()).toMatchObject({ inspection: true, mutation: false });
    expect(await fixture.service.proposeChange('fixture', 'enable', new AbortController().signal)).toMatchObject({ outcome: 'failed' });
    expect(fixture.proposal()).toBeUndefined();
  });
  it('restores disabled state when native installation unexpectedly activates code', async () => {
    const fixture = setup();
    fixture.manager.installPlugin.mockImplementationOnce(async (_repo, _version, next) => {
      fixture.manager.manifests.fixture = next;
      fixture.manager.enabledPlugins.add('fixture');
      fixture.manager.plugins.fixture = {};
    });
    const pending = fixture.service.proposeChange('fixture', 'install', new AbortController().signal);
    await waitReview(fixture); fixture.decide('approve');
    expect(await pending).toMatchObject({ outcome: 'applied', observed: { configuredEnabled: false, loaded: false }, message: expect.stringContaining('Code may have executed') });
  });
  it('halts update when native disable resolves without stopping loaded code', async () => {
    const fixture = setup(true, true, true);
    fixture.manager.disablePluginAndSave.mockImplementationOnce(async () => {});
    const pending = fixture.service.proposeChange('fixture', 'update', new AbortController().signal);
    await waitReview(fixture); fixture.decide('approve');
    expect(await pending).toMatchObject({ outcome: 'failed', observed: { version: '1.0.0', configuredEnabled: true, loaded: true } });
    expect(fixture.manager.installPlugin).not.toHaveBeenCalled();
  });
  it('does not change Restricted mode or offer approval when native mutations are restricted', async () => {
    const fixture = setup(true);
    fixture.manager.isEnabled.mockReturnValue(false);
    expect(await fixture.service.proposeChange('fixture', 'enable', new AbortController().signal)).toMatchObject({ outcome: 'failed', message: expect.stringContaining('restricted') });
    expect(fixture.proposal()).toBeUndefined();
    expect(fixture.manager.enablePluginAndSave).not.toHaveBeenCalled();
  });
  it('reports uninstall residue rather than deleting files through another path', async () => {
    const fixture = setup(true);
    fixture.manager.uninstallPlugin.mockImplementationOnce(async () => {});
    const pending = fixture.service.proposeChange('fixture', 'uninstall', new AbortController().signal);
    await waitReview(fixture); fixture.decide('approve');
    expect(await pending).toMatchObject({ outcome: 'failed', partial: true, observed: { installed: true }, message: expect.stringContaining('no filesystem cleanup') });
  });
});

describe('official release protocol', () => {
  it('accepts registry IDs with interior dots without allowing path traversal', async () => {
    const entry = { id: 'scrybble.ink', name: 'Scrybble', author: 'Fixture', description: '', repo: 'owner/scrybble' };
    vi.mocked(nodeFetch).mockResolvedValue(new Response(JSON.stringify([entry])));
    expect((await new PluginRegistry().list(new AbortController().signal)).entries).toEqual([entry]);
    for (const id of ['../fixture', 'fixture..other', '.hidden', 'fixture.', 'folder/fixture']) {
      vi.mocked(nodeFetch).mockResolvedValueOnce(new Response(JSON.stringify([{ ...entry, id }])));
      await expect(new PluginRegistry().list(new AbortController().signal)).rejects.toThrow('Invalid community plugin ID');
    }
  });
  it('selects the numerically highest compatible stable release and exact manifest', async () => {
    target = manifest('2.0.0', '9.0.0');
    expect(await new PluginRegistry().resolve('fixture', new AbortController().signal)).toMatchObject({ targetVersion: '1.10.0', olderCompatible: true, manifest: { version: '1.10.0' }, source: 'https://github.com/owner/fixture/releases/download/1.10.0/manifest.json' });
  });
  it('rejects arbitrary repository sources and mismatched release manifests', async () => {
    for (const repo of ['https://evil/x', 'owner/../repo', 'owner/repo?x', 'owner/repo/extra']) expect(() => validateRepository(repo)).toThrow();
    vi.mocked(nodeFetch).mockImplementation(async input => new Response(JSON.stringify(String(input).endsWith('community-plugins.json') ? [{ id: 'fixture', name: 'Fixture', description: '', author: '', repo: 'owner/fixture' }] : String(input).includes('/releases/') ? manifest('3.0.0') : manifest('2.0.0'))));
    await expect(new PluginRegistry().resolve('fixture', new AbortController().signal)).rejects.toThrow('Exact release');
  });
});
