import { describe, it, expect, vi } from 'vitest';
// vi.mock is hoisted; load the mock fixture within its factory, before production imports.
vi.mock('obsidian', async () => (await import('./fixtures/knowledge')).obsidian);
import { knowledgeFixture, invoke } from './fixtures/knowledge';
import { MetadataService } from '../src/agent/metadata-tools';
function setup() {
  const f = knowledgeFixture(); for (const path of ['A.md', 'B.md', 'C.md', 'D.md']) f.add(path);
  f.add('Unindexed.md', null); f.add('.private/Hidden.md');
  f.metadataCache.resolvedLinks = { 'A.md': { 'B.md': 3, '.private/Hidden.md': 1 }, 'B.md': { 'C.md': 1 }, 'D.md': { 'D.md': 1 } }; f.metadataCache.unresolvedLinks = { 'A.md': { Missing: 1 } };
  const service = new MetadataService(f.app, f.owner); return { ...f, service };
}
describe('native graph queries', () => {
  it('preserves native counts and direction with deterministic shortest paths', async () => {
    const f = setup(); const run = (args: Record<string, unknown>) => invoke(f.service, 'query_graph', args);
    expect((await run({ operation: 'backlinks', path: 'B.md' })).results).toEqual([{ source: 'A.md', destination: 'B.md', count: 3 }]);
    expect(await run({ operation: 'shortest_path', from: 'A.md', to: 'C.md', direction: 'outgoing' })).toMatchObject({ status: 'found', nodes: ['A.md', 'B.md', 'C.md'] });
    expect(await run({ operation: 'shortest_path', from: 'C.md', to: 'A.md', direction: 'outgoing' })).toMatchObject({ status: 'no_path_in_cached_graph', cacheStatus: 'partial' });
    expect((await run({ operation: 'shortest_path', from: 'C.md', to: 'A.md' })).nodes).toEqual(['C.md', 'B.md', 'A.md']);
    expect(await run({ operation: 'shortest_path', from: 'A.md', to: 'C.md', maxDepth: 1 })).toMatchObject({ status: 'search_limit_reached', truncated: true });
    expect(await run({ operation: 'shortest_path', from: 'A.md', to: 'C.md', maxVisited: 1 })).toMatchObject({ status: 'search_limit_reached' });
    expect((await run({ operation: 'shortest_path', from: 'A.md', to: 'A.md' })).nodes).toEqual(['A.md']);
    f.add('AA.md'); f.metadataCache.resolvedLinks['A.md']!['AA.md'] = 1; f.metadataCache.resolvedLinks['AA.md'] = { 'C.md': 1 };
    expect((await run({ operation: 'shortest_path', from: 'A.md', to: 'C.md', direction: 'outgoing' })).nodes).toEqual(['A.md', 'AA.md', 'C.md']); f.service.dispose();
  });
  it('excludes unindexed orphans, self degree, hidden nodes, and invented unresolved nodes', async () => {
    const f = setup(); const orphans = await invoke(f.service, 'query_graph', { operation: 'orphans' }); expect(orphans.results).toEqual([{ path: 'D.md' }]); expect(orphans.skippedUnindexed).toBe(1);
    expect((await invoke(f.service, 'query_graph', { operation: 'unresolved' })).results).toEqual([{ source: 'A.md', linktext: 'Missing', count: 1 }]);
    expect(await invoke(f.service, 'query_graph', { operation: 'neighbors', path: 'A.md', depth: 3, limit: 2 })).toMatchObject({ nodes: [{ path: 'A.md', depth: 0 }, { path: 'B.md', depth: 1 }], truncated: true });
    await expect(invoke(f.service, 'query_graph', { operation: 'outlinks', path: '../A.md' })).rejects.toThrow(); await expect(invoke(f.service, 'query_graph', { operation: 'outlinks', path: 'Absent.md' })).rejects.toThrow(); f.service.dispose();
  });
  it('paginates in vault order and succeeds on an empty vault', async () => {
    const f = knowledgeFixture(); const service = new MetadataService(f.app, f.owner);
    expect((await invoke(service, 'query_graph', { operation: 'orphans' })).results).toEqual([]);
    for (const path of ['Z.md', 'A.md', 'M.md']) f.add(path); f.metadataCache.emit('resolved');
    expect(await invoke(service, 'query_graph', { operation: 'orphans', limit: 2 })).toMatchObject({ results: [{ path: 'A.md' }, { path: 'M.md' }], nextOffset: 2, truncated: true, cacheStatus: 'snapshot' });
    expect(await invoke(service, 'query_graph', { operation: 'orphans', offset: 2, limit: 2 })).toMatchObject({ results: [{ path: 'Z.md' }], nextOffset: null, truncated: false }); service.dispose();
  });
  it('rejects mixed cache revisions across yielded work and observes cancellation', async () => {
    const f = knowledgeFixture(); for (let i = 0; i < 250; i++) f.add(`${i}.md`); const service = new MetadataService(f.app, f.owner);
    const pending = invoke(service, 'query_graph', { operation: 'orphans' }); f.metadataCache.emit('changed'); await expect(pending).rejects.toThrow('cache_changed; rerun the query');
    const abort = new AbortController(); const cancelled = invoke(service, 'query_graph', { operation: 'orphans' }, abort.signal); abort.abort(); await expect(cancelled).rejects.toThrow('Query cancelled'); service.dispose();
  });
});
