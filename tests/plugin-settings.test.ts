import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { PluginBridge } from '../src/plugins/bridge';
import { PluginSettingsService } from '../src/plugins/settings';
import { ApprovalController } from '../src/ui/approval';
import { fieldsOf, patchSettings } from '../src/plugins/settings-data';
import type { SettingsJson } from '../src/plugins/settings-types';

interface ReviewFixture { service: PluginSettingsService; approval: ApprovalController }

function setup(enabled = false, loaded = false) {
  let bytes = '{"theme":"dark","secret":"private-token","nested":{"count":1},"a/b":[1,2]}';
  let missing = false;
  const manager = {
    manifests: { fixture: { id: 'fixture', name: 'Fixture', version: '1.0.0', minAppVersion: '1.0.0', author: 'Test', description: '' } },
    enabledPlugins: new Set(enabled ? ['fixture'] : []), plugins: (loaded ? { fixture: {} } : {}) as Record<string, unknown>, isEnabled: () => true,
    disablePluginAndSave: vi.fn(async () => { manager.enabledPlugins.delete('fixture'); delete manager.plugins.fixture; }),
    enablePluginAndSave: vi.fn(async () => { manager.enabledPlugins.add('fixture'); manager.plugins.fixture = {}; }),
    enablePlugin: vi.fn(async () => { manager.plugins.fixture = {}; }),
  };
  const adapter = { stat: async () => missing ? null : { type: 'file', size: Buffer.byteLength(bytes) }, read: async () => bytes, process: vi.fn(async (_path: string, transform: (value: string) => string) => { bytes = transform(bytes); }) };
  const app = { vault: { configDir: '.custom', adapter }, plugins: manager } as unknown as App;
  const approval = new ApprovalController();
  let queue: Promise<unknown> = Promise.resolve();
  const service = new PluginSettingsService(app, 'obsidiai', new PluginBridge(app), approval, action => { const next = queue.then(action); queue = next.catch(() => {}); return next; }, signal => signal ?? new AbortController().signal);
  return { service, approval, manager, adapter, bytes: () => bytes, replace: (value: string) => { bytes = value; }, missing: () => { missing = true; } };
}
async function review(f: ReviewFixture) { await vi.waitFor(() => expect(f.approval.current).not.toBeNull()); return f.approval.current!; }
async function inspect(f: ReviewFixture, paths = ['/theme']) {
  const operation = f.service.inspectSettings('fixture'); const pending = await review(f);
  if (pending.proposal.kind !== 'plugin-settings-read') throw new Error('Wrong review');
  pending.proposal.select(paths); f.approval.decide(pending.id, 'approve');
  const result = await operation;
  if (result.outcome !== 'shared') throw new Error('Not shared');
  return result;
}
async function change(f: ReviewFixture, revision: string) {
  const operation = f.service.proposeSettingsChange('fixture', revision, [{ operation: 'set', path: '/theme', value: 'light' }]);
  const pending = await review(f); f.approval.decide(pending.id, 'approve'); return operation;
}
describe('reviewed saved plugin JSON', () => {
  it('shares only selected fields and keeps stale selection callbacks inert', async () => {
    const f = setup(); const operation = f.service.inspectSettings('fixture'); const pending = await review(f);
    if (pending.proposal.kind !== 'plugin-settings-read') throw new Error('Wrong review');
    const selected = ['/theme']; pending.proposal.select(selected); selected.push('/secret');
    f.approval.decide(pending.id, 'approve');
    pending.proposal.select(['/secret']);
    const result = await operation;
    pending.proposal.select(['/secret']);
    expect(result).toMatchObject({ outcome: 'shared', fields: [{ path: '/theme', value: 'dark' }], omittedCount: 3 });
    expect(JSON.stringify(result)).not.toContain('secret'); expect(JSON.stringify(result)).not.toContain('private-token');
    if (result.outcome !== 'shared') throw new Error('Not shared');
    expect((await f.service.proposeSettingsChange('fixture', result.revision, [{ operation: 'set', path: '/secret', value: 'replacement' }])).outcome).toBe('failed');
  });
  it.each(['reject', 'abort'] as const)('discloses no values or receipt on %s', async action => {
    const f = setup(); const signal = new AbortController(); const operation = f.service.inspectSettings('fixture', signal.signal); const pending = await review(f);
    if (pending.proposal.kind !== 'plugin-settings-read') throw new Error('Wrong review');
    pending.proposal.select(['/secret']);
    if (action === 'abort') signal.abort(); else f.approval.decide(pending.id, 'reject');
    f.approval.decide(pending.id, 'approve');
    expect(await operation).toEqual({ outcome: action === 'abort' ? 'cancelled' : 'rejected', pluginId: 'fixture' });
  });
  it('keeps oversized selections local until a valid subset is approved', async () => {
    const f = setup();
    f.replace(JSON.stringify({ a: 'a'.repeat(15_000), b: 'b'.repeat(15_000), c: 'c'.repeat(15_000), huge: 'x'.repeat(16_000) }));
    const operation = f.service.inspectSettings('fixture'); const pending = await review(f);
    if (pending.proposal.kind !== 'plugin-settings-read') throw new Error('Wrong review');
    const select = pending.proposal.select;
    expect(() => select(['/huge'])).toThrow();
    expect(() => select(['/a', '/b', '/c'])).toThrow();
    expect(f.approval.current?.id).toBe(pending.id);
    select(['/a', '/b']); f.approval.decide(pending.id, 'approve');
    const result = await operation;
    if (result.outcome !== 'shared') throw new Error('Not shared');
    expect(result.fields.map(field => field.path)).toEqual(['/a', '/b']);
  });
  it('preserves undisclosed data while applying an exact disclosed leaf patch', async () => {
    const f = setup(); const result = await inspect(f); expect((await change(f, result.revision)).outcome).toBe('applied');
    expect(JSON.parse(f.bytes())).toEqual({ theme: 'light', secret: 'private-token', nested: { count: 1 }, 'a/b': [1, 2] });
  });
  it('allows adding new keys without sharing any existing values', async () => {
    const f = setup(); const result = await inspect(f, []);
    const operation = f.service.proposeSettingsChange('fixture', result.revision, [{ operation: 'set', path: '/nested/new', value: true }]);
    const pending = await review(f); f.approval.decide(pending.id, 'approve');
    expect((await operation).outcome).toBe('applied'); expect(JSON.parse(f.bytes()).nested).toEqual({ count: 1, new: true });
  });
  it('rejects stale disclosure review and stale write approval', async () => {
    const f = setup(); const read = f.service.inspectSettings('fixture'); const readReview = await review(f);
    f.replace('{"theme":"user"}'); f.approval.decide(readReview.id, 'approve'); await expect(read).rejects.toThrow('changed');
    const result = await inspect(f); const write = f.service.proposeSettingsChange('fixture', result.revision, [{ operation: 'set', path: '/theme', value: 'model' }]); const pending = await review(f);
    f.replace('{"theme":"new-user"}'); f.approval.decide(pending.id, 'approve'); expect((await write).outcome).toBe('failed'); expect(f.bytes()).toBe('{"theme":"new-user"}');
  });
  it.each([[true, true], [false, true], [false, false], [true, false]])('restores configured=%s loaded=%s intent', async (enabled, loaded) => {
    const f = setup(enabled, loaded); const result = await inspect(f); const written = await change(f, result.revision);
    expect(written).toMatchObject({ outcome: 'applied', persisted: true, observed: { configuredEnabled: enabled, loaded: loaded || enabled } });
  });
  it('aborts stale unload-save patch and restores the prior loaded state', async () => {
    const f = setup(true, true); const result = await inspect(f);
    f.manager.disablePluginAndSave.mockImplementation(async () => { f.manager.enabledPlugins.clear(); delete f.manager.plugins.fixture; f.replace('{"theme":"saved-on-unload"}'); });
    const written = await change(f, result.revision);
    expect(written).toMatchObject({ outcome: 'failed', persisted: false, observed: { configuredEnabled: true, loaded: true } });
    expect(f.bytes()).toBe('{"theme":"saved-on-unload"}');
  });
  it('reports persisted settings and actual partial state when restarting fails', async () => {
    const f = setup(true, true); const result = await inspect(f); f.manager.enablePluginAndSave.mockRejectedValue(new Error('private-token'));
    const written = await change(f, result.revision);
    expect(written).toMatchObject({ outcome: 'failed', persisted: true, partial: true, observed: { configuredEnabled: false, loaded: false } });
    expect(JSON.stringify(written)).not.toContain('private-token');
  });
  it('reports actual saved data after recovery from a failed write', async () => {
    const f = setup(true, true); const result = await inspect(f);
    f.adapter.process.mockImplementation(async (_path, transform) => { f.replace(transform(f.bytes())); throw new Error('Write acknowledgement failed'); });
    f.manager.enablePluginAndSave.mockImplementation(async () => {
      f.manager.enabledPlugins.add('fixture'); f.manager.plugins.fixture = {};
      f.replace('{"theme":"plugin-reset"}');
    });
    expect(await change(f, result.revision)).toMatchObject({ outcome: 'failed', persisted: false, partial: true, observed: { configuredEnabled: true, loaded: true } });
    expect(f.bytes()).toBe('{"theme":"plugin-reset"}');
  });
  it('allows reviewed disclosure in read-only mode but never writes or auto-approves disclosure', async () => {
    const f = setup(); f.approval.setMode('read-only'); const result = await inspect(f);
    expect((await f.service.proposeSettingsChange('fixture', result.revision, [{ operation: 'set', path: '/theme', value: 'light' }])).outcome).toBe('rejected');
    expect(JSON.parse(f.bytes()).theme).toBe('dark');
    f.approval.setMode('auto-approve-notes'); const operation = f.service.inspectSettings('fixture'); const pending = await review(f); f.approval.decide(pending.id, 'reject'); expect((await operation).outcome).toBe('rejected');
  });
  it.each(['missing', 'corrupt', 'oversized'] as const)('does not review %s settings', async mode => {
    const f = setup(); if (mode === 'missing') f.missing(); else f.replace(mode === 'corrupt' ? '{bad' : JSON.stringify({ huge: 'x'.repeat(262144) }));
    await expect(f.service.inspectSettings('fixture')).rejects.toThrow(); expect(f.approval.current).toBeNull();
  });
  it('finishes approved restoration after Stop once the write has started', async () => {
    const f = setup(true, true); const result = await inspect(f); const abort = new AbortController();
    f.adapter.process.mockImplementation(async (_path, transform) => { f.replace(transform(f.bytes())); abort.abort(); });
    const operation = f.service.proposeSettingsChange('fixture', result.revision, [{ operation: 'set', path: '/theme', value: 'light' }], abort.signal);
    const pending = await review(f); f.approval.decide(pending.id, 'approve');
    expect(await operation).toMatchObject({ outcome: 'applied', persisted: true, observed: { configuredEnabled: true, loaded: true } });
  });
  it('compares the exact reviewed bytes inside the atomic commit callback', async () => {
    const f = setup(); const result = await inspect(f);
    f.adapter.process.mockImplementation(async (_path, transform) => { f.replace('{"theme":"concurrent"}'); f.replace(transform(f.bytes())); });
    expect(await change(f, result.revision)).toMatchObject({ outcome: 'failed', persisted: false });
    expect(f.bytes()).toBe('{"theme":"concurrent"}');
  });
  it('invalidates receipts after successful reinspection and disposal', async () => {
    const f = setup(); const original = await inspect(f); const current = await inspect(f, []);
    expect((await f.service.proposeSettingsChange('fixture', original.revision, [{ operation: 'set', path: '/theme', value: 'light' }])).outcome).toBe('failed');
    f.service.dispose();
    expect((await f.service.proposeSettingsChange('fixture', current.revision, [{ operation: 'set', path: '/new', value: true }])).outcome).toBe('cancelled');
  });
  it('bounds repeated long JSON paths before building local disclosure rows', () => {
    expect(() => fieldsOf({ ['x'.repeat(16_000)]: { leaf: true } })).toThrow();
  });
  it('handles pointer escapes, atomic arrays, unsafe paths and malformed direct-call values', () => {
    expect(JSON.parse(patchSettings('{"a/b":[1]}', [{ operation: 'set', path: '/a~1b', value: [2] }], new Set(['/a~1b'])).after)).toEqual({ 'a/b': [2] });
    for (const path of ['', '/a~2b', '/__proto__/x', '/constructor', '/a~1b/0']) expect(() => patchSettings('{"a/b":[1]}', [{ operation: 'set', path, value: 2 }], new Set([path]))).toThrow();
    const cycle: Record<string, SettingsJson> = {}; cycle.self = cycle;
    for (const value of [NaN, Infinity, undefined, cycle, new Date()]) {
      // Deliberately malformed direct-call values exercise the runtime boundary.
      expect(() => patchSettings('{}', [{ operation: 'set', path: '/new', value: value as SettingsJson }], new Set())).toThrow();
    }
  });
});
