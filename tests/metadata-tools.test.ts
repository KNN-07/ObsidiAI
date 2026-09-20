import { describe, it, expect, vi } from 'vitest';
// vi.mock is hoisted; load the fixture within its factory before production imports.
vi.mock('obsidian', async () => (await import('./fixtures/knowledge')).obsidian);
import { knowledgeFixture, invoke, TFolder } from './fixtures/knowledge';
import { MetadataService } from '../src/agent/metadata-tools';

const pos = { start: { line: 2, col: 0, offset: 4 }, end: { line: 2, col: 4, offset: 8 } };
describe('native metadata queries', () => {
  it('uses exact tags, strict properties, own keys, and complete folder segments', async () => {
    const f = knowledgeFixture(); f.files.set('Projects', new TFolder('Projects'));
    f.add('Projects/A.md', { tags: [{ tag: '#Project', position: pos }, { tag: '#team/research', position: pos }], frontmatter: { status: 'active', owners: ['Ada'], nullable: null } });
    f.add('ProjectsElse/B.md', { frontmatter: { status: 'active', owners: ['Ada'] } }); f.add('Unknown.md', null);
    const service = new MetadataService(f.app, f.owner);
    const found = await invoke(service, 'query_notes', { folder: 'Projects', tags: ['project'], properties: [{ key: 'status', op: 'equals', value: 'active' }, { key: 'owners', op: 'contains', value: 'Ada' }] });
    expect(found.results.map((n: { path: string }) => n.path)).toEqual(['Projects/A.md']); expect(found.cacheStatus).toBe('partial');
    expect((await invoke(service, 'query_notes', { tags: ['team'] })).results).toEqual([]);
    expect((await invoke(service, 'query_notes', { properties: [{ key: 'nullable', op: 'equals', value: null }] })).results.map((n: { path: string }) => n.path)).toEqual(['Projects/A.md']);
    expect((await invoke(service, 'query_notes', { properties: [{ key: 'missing', op: 'equals', value: null }] })).results).toEqual([]);
    expect((await invoke(service, 'query_notes', { properties: [{ key: 'owners', op: 'contains', value: true }] })).results).toEqual([]);
    service.dispose();
  });
  it('bounds cache serialization and resolves relative references before applying scope rules', async () => {
    const f = knowledgeFixture(); f.add('Other.md');
    f.add('Folder/A.md', { frontmatter: { position: {}, nested: { secret: 'not serialized' }, long: 'x'.repeat(5000), values: Array.from({ length: 70 }, (_, i) => i) }, headings: [{ heading: 'Heading', level: 1, position: pos }], listItems: [{ task: 'x', parent: -1, position: pos }], links: [{ link: '../Other#Heading', original: '[[../Other#Heading]]', position: pos }], frontmatterLinks: [{ link: '../Other', original: '[[../Other]]', key: 'related' }] });
    const service = new MetadataService(f.app, f.owner); const metadata = await invoke(service, 'get_note_metadata', { path: 'Folder/A.md' });
    expect(metadata.links.results[0]).toMatchObject({ resolvedPath: 'Other.md', subpath: '#Heading', line: 3 });
    expect(metadata.frontmatterLinks.results[0]).toMatchObject({ key: 'related', resolvedPath: 'Other.md' }); expect(metadata.frontmatterLinks.results[0]).not.toHaveProperty('line');
    expect(metadata.frontmatter.values.long).toHaveLength(4096); expect(metadata.frontmatter.values.values).toHaveLength(64); expect(metadata.frontmatter.omittedItems).toBe(6); expect(metadata.frontmatter.omittedKeys).toEqual(['position', 'nested']);
    expect(metadata.headings.results[0].line).toBe(3); expect(metadata.tasks.results[0]).toEqual({ marker: 'x', line: 3 }); service.dispose();
  });
  it('reports unavailable caches and observes resolution and rename/delete revisions', async () => {
    const f = knowledgeFixture(); f.add('A.md', null); const service = new MetadataService(f.app, f.owner);
    expect(await invoke(service, 'get_note_metadata', { path: 'A.md' })).toMatchObject({ status: 'not_indexed', cacheStatus: 'partial', resolutionState: 'unknown' });
    f.caches['A.md'] = {}; f.metadataCache.emit('resolved');
    expect(await invoke(service, 'get_vault_info')).toMatchObject({ cacheStatus: 'snapshot', revision: 1 });
    f.files.delete('A.md'); f.add('Renamed.md'); f.vault.emit('rename');
    expect((await invoke(service, 'query_notes')).results).toEqual([{ path: 'Renamed.md', tags: [] }]);
    f.files.delete('Renamed.md'); f.vault.emit('delete'); expect(await invoke(service, 'get_vault_info')).toMatchObject({ markdownCount: 0, revision: 3, cacheStatus: 'partial' }); service.dispose();
  });
});
