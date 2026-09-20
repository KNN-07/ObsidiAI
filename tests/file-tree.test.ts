import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({
  TFile: class {},
  TFolder: class {},
  MarkdownView: class {},
}));
import { TFile, TFolder, type App } from 'obsidian';
import { VaultToolService } from '../src/agent/vault-tools';

function fixture(configDir = '.obsidian') {
  const nodes = new Map<string, TFile | TFolder>();
  const root = Object.assign(new TFolder(), { path: '', children: [] as (TFile | TFolder)[] });
  nodes.set('', root);
  const add = (path: string, folder = false) => {
    const node = folder
      ? Object.assign(new TFolder(), { path, children: [] as (TFile | TFolder)[] })
      : Object.assign(new TFile(), { path, extension: path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : '' });
    nodes.set(path, node);
    const slash = path.lastIndexOf('/');
    const parent = nodes.get(slash < 0 ? '' : path.slice(0, slash)) as TFolder;
    parent.children.push(node);
    return node;
  };
  const read = vi.fn(() => { throw new Error('File tree must not read file bodies.'); });
  const app = { vault: {
    configDir, getRoot: () => root, getAbstractFileByPath: (path: string) => nodes.get(path) ?? null,
    read, cachedRead: read,
  } } as unknown as App;
  const service = new VaultToolService(app, null!);
  service.beginRun();
  const tool = service.tools.find(value => value.name === 'list_files')!;
  const list = async (args: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const response = await tool.execute('tree', args, signal);
    return response.details as {
      path: string; root: boolean; depth: number; entries: { path: string; type: string; extension?: string }[];
      truncated: boolean; nextCursor: string | null; depthLimitReached: boolean;
    };
  };
  return { add, root, nodes, read, service, list };
}

describe('read-only vault file tree', () => {
  it('exposes empty folders and non-Markdown file types without reading bodies', async () => {
    const f = fixture();
    f.add('Empty', true); f.add('picture.png'); f.add('Note.md');
    const page = await f.list();
    expect(page).toMatchObject({ path: '', root: true, depth: 1, truncated: false, nextCursor: null });
    expect(page.entries).toEqual([
      { path: 'Empty', type: 'folder' },
      { path: 'picture.png', type: 'file', extension: 'png' },
      { path: 'Note.md', type: 'file', extension: 'md' },
    ]);
    expect(await f.list({ path: 'Empty' })).toMatchObject({ path: 'Empty', root: false, entries: [], truncated: false, nextCursor: null });
    expect(f.read).not.toHaveBeenCalled();
  });

  it('bounds subtree depth and paginates deterministic native-order traversal without duplicates', async () => {
    const f = fixture();
    f.add('Projects', true); f.add('Projects/Z', true); f.add('Projects/Z/Deep', true);
    f.add('Projects/Z/Deep/HiddenByDepth.md'); f.add('Projects/Z/A.md'); f.add('Projects/B.md'); f.add('Outside.md');
    const shallow = await f.list({ path: 'Projects' });
    expect(shallow.entries.map(entry => entry.path)).toEqual(['Projects/Z', 'Projects/B.md']);
    expect(shallow.depthLimitReached).toBe(true);
    const args = { path: 'Projects', depth: 2, limit: 2 };
    const first = await f.list(args);
    expect(first.entries.map(entry => entry.path)).toEqual(['Projects/Z', 'Projects/Z/Deep']);
    expect(first.truncated).toBe(true);
    const second = await f.list({ ...args, cursor: first.nextCursor });
    expect(second.entries.map(entry => entry.path)).toEqual(['Projects/Z/A.md', 'Projects/B.md']);
    expect(second).toMatchObject({ truncated: false, nextCursor: null });
    expect((await f.list(args)).entries).toEqual(first.entries);
    expect((await f.list({ path: 'Projects/Z/Deep' })).entries.map(entry => entry.path)).toEqual(['Projects/Z/Deep/HiddenByDepth.md']);
    await expect(f.list({ ...args, cursor: first.nextCursor })).rejects.toThrow('cursor expired');
  });

  it('excludes hidden/config subtrees and rejects unsafe or non-folder query roots', async () => {
    const f = fixture('Config');
    f.add('Config', true); f.add('Config/secret.json'); f.add('.hidden', true); f.add('.hidden/private.md');
    f.add('Config-notes', true); f.add('Config-notes/Public.md'); f.add('Visible.md');
    expect((await f.list({ depth: 3 })).entries.map(entry => entry.path)).toEqual(['Config-notes', 'Config-notes/Public.md', 'Visible.md']);
    for (const path of ['Config', 'Config/secret.json', '.hidden', '../escape', '/absolute', 'A//B', 'A\\B', 'https:evil', 'Visible.md', 'Missing']) {
      await expect(f.list({ path })).rejects.toThrow();
    }
  });

  it('continues after a bounded hidden-only page rather than reporting false completion', async () => {
    const f = fixture();
    for (let index = 0; index < 1_005; index++) f.add(`.hidden-${index}`);
    f.add('Destination', true);
    const first = await f.list();
    expect(first.entries).toEqual([]);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await f.list({ cursor: first.nextCursor });
    expect(second.entries).toEqual([{ path: 'Destination', type: 'folder' }]);
    expect(second).toMatchObject({ truncated: false, nextCursor: null });
  });

  it('honors cancellation before traversal and while yielding on a large root', async () => {
    const f = fixture();
    for (let index = 0; index < 1_005; index++) f.add(`.hidden-${index}`);
    const alreadyAborted = new AbortController(); alreadyAborted.abort();
    await expect(f.list({}, alreadyAborted.signal)).rejects.toThrow('cancelled');
    const abort = new AbortController();
    const listing = f.list({}, abort.signal);
    queueMicrotask(() => abort.abort());
    await expect(listing).rejects.toThrow('cancelled');
    expect(f.read).not.toHaveBeenCalled();
  });

  it('invalidates stale/run-ended cursors and refuses to repurpose a cursor for another subtree', async () => {
    const f = fixture();
    f.add('Folder', true); f.add('A.md'); f.add('B.md');
    const first = await f.list({ limit: 1 });
    await expect(f.list({ path: 'Folder', cursor: first.nextCursor })).rejects.toThrow('same path and depth');
    f.add('C.md');
    await expect(f.list({ cursor: first.nextCursor })).rejects.toThrow('tree changed');
    const next = await f.list({ limit: 1 });
    f.service.endRun();
    await expect(f.list({ cursor: next.nextCursor })).rejects.toThrow('cursor expired');
    await expect(f.list({ depth: 4 })).rejects.toThrow('depth');
    await expect(f.list({ limit: 201 })).rejects.toThrow('limit');
  });
});
