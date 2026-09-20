import { vi } from 'vitest';
import type { App, Plugin, CachedMetadata } from 'obsidian';
import type { AgentTool } from '@earendil-works/pi-agent-core';
export class TFile { extension = 'md'; stat = { ctime: 1, mtime: 2, size: 10 }; constructor(public path: string) {} }
export class TFolder { constructor(public path: string) {} }
export const obsidian = {
  TFile, TFolder,
  getAllTags: (cache: CachedMetadata) => [...(cache.tags ?? []).map(x => x.tag), ...(Array.isArray(cache.frontmatter?.tags) ? cache.frontmatter.tags as string[] : [])],
  parseLinktext: (link: string) => { const i = link.indexOf('#'); return { path: i < 0 ? link : link.slice(0, i), subpath: i < 0 ? '' : link.slice(i) }; },
};
export function knowledgeFixture() {
  const files = new Map<string, TFile | TFolder>(); const caches: Record<string, CachedMetadata | null> = Object.create(null);
  function events() {
    const handlers = new Map<string, Set<() => void>>();
    return {
      on(name: string, callback: () => void) { let set = handlers.get(name); if (!set) handlers.set(name, set = new Set()); set.add(callback); return { name, callback }; },
      offref(ref: { name: string; callback: () => void }) { handlers.get(ref.name)?.delete(ref.callback); },
      emit(name: string) { for (const callback of handlers.get(name) ?? []) callback(); },
    };
  }
  const vault = { ...events(), configDir: '.obsidian', getMarkdownFiles: () => [...files.values()].filter(f => f instanceof TFile), getAllLoadedFiles: () => [...files.values()], getName: () => 'Knowledge', getAbstractFileByPath: (path: string) => files.get(path) ?? null };
  const metadataCache = { ...events(), resolvedLinks: {} as Record<string, Record<string, number>>, unresolvedLinks: {} as Record<string, Record<string, number>>, getFileCache: (file: TFile) => caches[file.path] ?? null, getFirstLinkpathDest: vi.fn((path: string, source: string) => {
    const parts = source.split('/'); parts.pop(); for (const part of path.split('/')) { if (part === '..') parts.pop(); else if (part !== '.') parts.push(part); } const target = parts.join('/'); return files.get(target.endsWith('.md') ? target : target + '.md') ?? files.get(path + '.md') ?? null;
  }) };
  const add = (path: string, cache: CachedMetadata | null = {}) => { const file = new TFile(path); files.set(path, file); caches[path] = cache; return file; };
  // The fixture intentionally implements only the public APIs these tools consume.
  return { app: { vault, metadataCache } as unknown as App, owner: { registerEvent: vi.fn() } as unknown as Plugin, files, caches, add, vault, metadataCache };
}
export async function invoke(service: { tools: AgentTool[] }, name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
  return (await service.tools.find(tool => tool.name === name)!.execute('call', args, signal)).details;
}
