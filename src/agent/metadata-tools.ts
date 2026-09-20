import { TFile, TFolder, getAllTags, parseLinktext, type App, type CachedMetadata, type Plugin, type Reference } from 'obsidian';
import { Type } from '@earendil-works/pi-ai';
import type { Static } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { validateVaultPath } from '../vault/paths';
import { createGraphTool } from './graph-tools';

export const pagination = { offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) };
export function page<T>(items: T[], offset = 0, limit = 50) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid pagination');
  const results = items.slice(offset, offset + limit);
  return { results, nextOffset: offset + results.length < items.length ? offset + results.length : null, truncated: offset + results.length < items.length };
}
export function result(details: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details }; }
export function allowed(path: string, app: App) { try { validateVaultPath(path, app.vault.configDir); return true; } catch { return false; } }
export function markdown(file: unknown, app: App): file is TFile { return file instanceof TFile && file.extension.toLowerCase() === 'md' && allowed(file.path, app); }
export function note(app: App, path: string) { validateVaultPath(path, app.vault.configDir); const file = app.vault.getAbstractFileByPath(path); if (!markdown(file, app)) throw new Error('An existing allowed Markdown note is required'); return file; }
const forbidden = { position: true, ['__proto__']: true, constructor: true, prototype: true } as const;
const scalar = (v: unknown): v is string | number | boolean | null => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
const text = (v: string) => v.slice(0, 4096);
export function boundedFrontmatter(frontmatter: CachedMetadata['frontmatter']) {
  const values: Record<string, unknown> = Object.create(null); const omittedKeys: string[] = []; let omittedItems = 0; let shortenedStrings = 0; let includedKeys = 0; let omittedKeyCount = 0;
  const bound = (v: string | number | boolean | null) => { if (typeof v === 'string' && v.length > 4096) shortenedStrings++; return typeof v === 'string' ? text(v) : v; };
  for (const key of Object.keys(frontmatter ?? {})) {
    const value: unknown = frontmatter![key];
    if (Object.hasOwn(forbidden, key) || includedKeys >= 200 || key.length > 4096 || (!scalar(value) && !(Array.isArray(value) && value.every(scalar)))) { omittedKeyCount++; if (omittedKeys.length < 200) omittedKeys.push(text(key)); continue; }
    includedKeys++;
    if (Array.isArray(value)) { values[key] = value.slice(0, 64).map(bound); omittedItems += Math.max(0, value.length - 64); } else values[key] = bound(value as string | number | boolean | null);
  }
  return { values, omittedKeys, omittedKeyCount, omittedItems, shortenedStrings };
}
export interface QuerySnapshot {
  files: TFile[]; revision: number; unindexedCount: number;
  check(): void; tick(): Promise<void>; info(extraMissing?: number): { revision: number; resolutionState: string; unindexedCount: number; cacheStatus: string; source: string };
}
export class MetadataService {
  readonly tools: AgentTool<any>[];
  private revision = 0;
  private resolutionState: 'unknown' | 'resolving' | 'resolved' = 'unknown';
  private disposed = false;
  private removers: (() => void)[] = [];
  constructor(readonly app: App, owner: Plugin) {
    const changed = () => { this.revision++; this.resolutionState = 'resolving'; };
    for (const ref of [app.metadataCache.on('changed', changed), app.metadataCache.on('deleted', changed), app.metadataCache.on('resolve', changed)]) { owner.registerEvent(ref); this.removers.push(() => app.metadataCache.offref(ref)); }
    const resolved = app.metadataCache.on('resolved', () => { this.revision++; this.resolutionState = 'resolved'; }); owner.registerEvent(resolved); this.removers.push(() => app.metadataCache.offref(resolved));
    for (const ref of [app.vault.on('create', changed), app.vault.on('modify', changed), app.vault.on('rename', changed), app.vault.on('delete', changed)]) { owner.registerEvent(ref); this.removers.push(() => app.vault.offref(ref)); }
    const value = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
    const property = Type.Union([Type.Object({ key: Type.String(), op: Type.Literal('exists') }), Type.Object({ key: Type.String(), op: Type.Union([Type.Literal('equals'), Type.Literal('contains')]), value })]);
    const queryParameters = Type.Object({ folder: Type.Optional(Type.String()), tags: Type.Optional(Type.Array(Type.String())), properties: Type.Optional(Type.Array(property)), ...pagination });
    this.tools = [
      { name: 'get_vault_info', label: 'Vault information', description: 'Visible vault counts from a native-cache snapshot; no filesystem paths or hidden configuration.', parameters: Type.Object({}), executionMode: 'sequential', execute: async (_id, _args, signal) => {
        const q = await this.snapshot(signal); let files = 0; let folders = 0;
        for (const item of app.vault.getAllLoadedFiles()) { if (allowed(item.path, app)) { if (item instanceof TFile) files++; else if (item instanceof TFolder) folders++; } await q.tick(); }
        q.check(); return result({ name: app.vault.getName(), markdownCount: q.files.length, fileCount: files, folderCount: folders, enabledToolCategories: ['notes', 'metadata', 'graph', 'skills', 'plugins'], ...q.info() });
      } },
      { name: 'get_note_metadata', label: 'Note metadata', description: 'Native cached tags, bounded properties, headings, tasks and source-relative links. Cache may lag edits.', parameters: Type.Object({ path: Type.String() }), executionMode: 'sequential', execute: async (_id, args: { path: string }, signal) => {
        const file = note(app, args.path); const q = await this.snapshot(signal); const cache = app.metadataCache.getFileCache(file);
        if (!cache) return result({ path: file.path, status: 'not_indexed', ...q.info(1) });
        const refs = (items: Reference[] | undefined, kind: 'body' | 'frontmatter') => ({ results: (items ?? []).slice(0, 200).map(ref => {
          const parsed = parseLinktext(ref.link); const resolved = app.metadataCache.getFirstLinkpathDest(parsed.path, file.path);
          return { link: text(ref.link), original: text(ref.original), displayText: ref.displayText === undefined ? undefined : text(ref.displayText), subpath: text(parsed.subpath), resolvedPath: resolved && allowed(resolved.path, app) ? resolved.path : null, ...(kind === 'frontmatter' ? { key: text((ref as Reference & { key: string }).key) } : { line: (ref as Reference & { position: { start: { line: number } } }).position.start.line + 1 }) };
        }), omittedCount: Math.max(0, (items?.length ?? 0) - 200) });
        const headings = cache.headings ?? []; const tasks = (cache.listItems ?? []).filter(item => item.task !== undefined); const tags = getAllTags(cache) ?? [];
        q.check(); return result({ path: file.path, status: 'indexed', stat: { ctime: file.stat.ctime, mtime: file.stat.mtime, size: file.stat.size }, tags: tags.slice(0, 200).map(text), omittedTagCount: Math.max(0, tags.length - 200), frontmatter: boundedFrontmatter(cache.frontmatter), headings: { results: headings.slice(0, 200).map(h => ({ heading: text(h.heading), level: h.level, line: h.position.start.line + 1 })), omittedCount: Math.max(0, headings.length - 200) }, tasks: { results: tasks.slice(0, 200).map(t => ({ marker: text(t.task!), line: t.position.start.line + 1 })), omittedCount: Math.max(0, tasks.length - 200) }, links: refs(cache.links, 'body'), embeds: refs(cache.embeds, 'body'), frontmatterLinks: refs(cache.frontmatterLinks, 'frontmatter'), ...q.info() });
      } },
      { name: 'query_notes', label: 'Query notes', description: 'Filter native cached notes by folder, exact case-insensitive tags and strict scalar frontmatter predicates. Snapshot may lag edits.', parameters: queryParameters, executionMode: 'sequential', execute: async (_id, args: Static<typeof queryParameters>, signal) => {
        const folder = args.folder ?? ''; if (folder) { validateVaultPath(folder, app.vault.configDir); if (!(app.vault.getAbstractFileByPath(folder) instanceof TFolder)) throw new Error('An existing allowed folder is required'); }
        const normalize = (tag: string) => '#' + tag.replace(/^#+/, '').toLowerCase(); const tags = (args.tags ?? []).map(normalize); const properties = args.properties ?? []; const q = await this.snapshot(signal); const matches: { path: string; tags: string[] }[] = []; let skipped = 0;
        for (const file of q.files) {
          await q.tick(); if (folder && !file.path.startsWith(folder + '/')) continue;
          const cache = app.metadataCache.getFileCache(file); if (!cache && (tags.length || properties.length)) { skipped++; continue; }
          const actualTags = cache ? getAllTags(cache) ?? [] : [];
          if (!tags.every(tag => actualTags.some(t => normalize(t) === tag))) continue;
          if (!properties.every(p => { if (Object.hasOwn(forbidden, p.key) || !Object.hasOwn(cache?.frontmatter ?? {}, p.key)) return false; const v: unknown = cache!.frontmatter![p.key]; return p.op === 'exists' || (p.op === 'equals' ? scalar(v) && v === p.value : Array.isArray(v) && v.every(scalar) && v.some(item => item === p.value)); })) continue;
          matches.push({ path: file.path, tags: actualTags.slice(0, 200).map(text) });
        }
        q.check(); return result({ ...page(matches, args.offset, args.limit), skippedUnindexed: skipped, ...q.info(skipped) });
      } }, createGraphTool(this),
    ] as AgentTool<any>[];
  }
  async snapshot(signal?: AbortSignal): Promise<QuerySnapshot> {
    const revision = this.revision; const state = this.resolutionState; let steps = 0;
    const check = () => { if (signal?.aborted || this.disposed) throw new Error('Query cancelled'); if (revision !== this.revision) throw new Error('cache_changed; rerun the query'); };
    const tick = async () => { check(); if (++steps % 100 === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); check(); } };
    check(); const files: TFile[] = []; let unindexedCount = 0;
    for (const file of this.app.vault.getMarkdownFiles()) { if (markdown(file, this.app)) { files.push(file); if (!this.app.metadataCache.getFileCache(file)) unindexedCount++; } await tick(); }
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { files, revision, unindexedCount, check, tick, info: (extraMissing = 0) => ({ revision, resolutionState: state, unindexedCount, cacheStatus: state !== 'resolved' || unindexedCount > 0 || extraMissing > 0 ? 'partial' : 'snapshot', source: 'native-cache snapshot; may lag unsaved or recent edits' }) };
  }
  dispose() { this.disposed = true; for (const remove of this.removers.splice(0)) remove(); }
}
