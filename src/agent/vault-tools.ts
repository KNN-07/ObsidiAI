import { MarkdownView, TFile, TFolder, type App } from 'obsidian';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { setTimeout as delay } from 'node:timers/promises';
import type { ApprovalController } from '../ui/approval';
import { validateVaultPath } from '../vault/paths';

export const MAX_NOTE_CHARACTERS = 200_000;
const STALE = 'Note changed since review; read it again and request a new approval.';
interface Snapshot { file: TFile; path: string; content: string }
interface TreeFrame { folder: TFolder; path: string; index: number; childCount: number; level: number }
interface TreePage { path: string; depth: number; frames: TreeFrame[] }
const TREE_SCAN_LIMIT = 1_000;
const TREE_CURSOR_LIMIT = 32;
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('Operation cancelled.'); }
function bounded(content: string): void {
  if (content.length > MAX_NOTE_CHARACTERS) throw new Error('Note content exceeds the 200,000-character limit.');
}
function result(data: Record<string, unknown>) { return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], details: data }; }

export class VaultToolService {
  readonly tools: AgentTool<any>[];
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly treePages = new Map<string, TreePage>();
  private run = 0;
  constructor(private readonly app: App, private readonly approval: ApprovalController) {
    const searchSchema = Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) });
    const readSchema = Type.Object({ path: Type.String() });
    const editSchema = Type.Object({ path: Type.String(), oldText: Type.String({ minLength: 1 }), newText: Type.String() });
    const createSchema = Type.Object({ path: Type.String(), content: Type.String({ maxLength: MAX_NOTE_CHARACTERS }) });
    const listSchema = Type.Object({
      path: Type.Optional(Type.String()),
      depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      cursor: Type.Optional(Type.String()),
    });
    this.tools = [
      { name: 'list_files', label: 'List vault files', description: 'Inspect visible vault folders (including empty ones) and file paths/types without reading bodies. Defaults to root, depth 1. Follow nextCursor with the same path/depth, including after empty pages. Native child-order traversal is stable while the tree is unchanged; query folders directly to explore beyond depth 3.',
        executionMode: 'sequential', parameters: listSchema,
        execute: async (_id, params, signal) => this.listFiles(params.path ?? '', params.depth ?? 1, params.limit ?? 50, params.cursor, signal) } satisfies AgentTool<typeof listSchema>,
      { name: 'search_notes', label: 'Search notes', description: 'Literal case-insensitive search of visible Markdown paths and bounded note bodies.', executionMode: 'sequential',
        parameters: searchSchema,
        execute: async (_id, params, signal) => this.search(params.query, params.limit ?? 20, signal) } satisfies AgentTool<typeof searchSchema>,
      { name: 'read_note', label: 'Read note', description: 'Read a visible Markdown note and retain an exact current-run edit snapshot.', executionMode: 'sequential',
        parameters: readSchema,
        execute: async (_id, params, signal) => {
          checkAbort(signal);
          const path = this.notePath(params.path);
          const file = this.file(path);
          const run = this.run;
          let content: string;
          try { content = await this.app.vault.read(file); } catch { throw new Error('Unable to read the note.'); }
          checkAbort(signal); bounded(content);
          if (run !== this.run || file.path !== path || this.app.vault.getFileByPath(path) !== file) throw new Error(STALE);
          this.snapshots.set(path, { file, path, content });
          return result({ path, content });
        } } satisfies AgentTool<typeof readSchema>,
      { name: 'propose_note_edit', label: 'Propose note edit', description: 'Propose one exact unique replacement against a note read in this run; writing follows the current conversation permission mode.', executionMode: 'sequential',
        parameters: editSchema,
        execute: async (_id, params, signal) => this.edit(params.path, params.oldText, params.newText, signal) } satisfies AgentTool<typeof editSchema>,
      { name: 'propose_note_create', label: 'Propose note creation', description: 'Propose a new Markdown note in an existing visible folder; writing follows the current conversation permission mode.', executionMode: 'sequential',
        parameters: createSchema,
        execute: async (_id, params, signal) => this.create(params.path, params.content, signal) } satisfies AgentTool<typeof createSchema>,
    ] as AgentTool<any>[];
  }
  beginRun(): void { this.run++; this.snapshots.clear(); this.treePages.clear(); }
  endRun(): void { this.run++; this.snapshots.clear(); this.treePages.clear(); }
  private notePath(path: string): string {
    validateVaultPath(path, this.app.vault.configDir);
    if (!path.toLowerCase().endsWith('.md')) throw new Error('Only Markdown (.md) notes are allowed.');
    return path;
  }
  private file(path: string): TFile {
    const file = this.app.vault.getFileByPath(path);
    if (!(file instanceof TFile)) throw new Error('Markdown note does not exist.');
    return file;
  }
  private checkCreate(path: string): void {
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error('A file or folder already exists at the proposed path.');
    const slash = path.lastIndexOf('/');
    const parent = slash < 0 ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(path.slice(0, slash));
    if (!(parent instanceof TFolder)) throw new Error('The parent folder must already exist.');
  }
  private async listFiles(path: string, depth: number, limit: number, cursor?: string, signal?: AbortSignal) {
    checkAbort(signal);
    if (!Number.isInteger(depth) || depth < 1 || depth > 3) throw new Error('File tree depth must be between 1 and 3.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('File tree limit must be between 1 and 200.');
    if (path !== '') validateVaultPath(path, this.app.vault.configDir);
    const root = path === '' ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(path);
    if (!(root instanceof TFolder)) throw new Error('File tree path must be an existing visible folder.');
    const previous = cursor === undefined ? undefined : this.treePages.get(cursor);
    if (cursor !== undefined && !previous) throw new Error('File tree cursor expired; start this folder listing again.');
    if (previous && (previous.path !== path || previous.depth !== depth)) throw new Error('Use the same path and depth when continuing a file tree listing.');
    const frame = (folder: TFolder, level: number): TreeFrame => ({ folder, path: folder.path, index: 0, childCount: folder.children.length, level });
    // Never sort/copy an entire children array: a vault root can contain arbitrarily many files.
    const frames = previous ? previous.frames.map(value => ({ ...value })) : [frame(root, 0)];
    const entries: { path: string; type: 'file' | 'folder'; extension?: string }[] = [];
    let inspected = 0;
    let depthLimitReached = false;
    const run = this.run;
    while (frames.length) {
      if (inspected % 50 === 0) await delay(0);
      checkAbort(signal);
      if (run !== this.run) throw new Error('File tree listing cancelled; start it again.');
      const current = frames[frames.length - 1]!;
      const resolved = current.level === 0 && path === '' ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(current.path);
      if (current.folder.path !== current.path || resolved !== current.folder || current.folder.children.length !== current.childCount) {
        throw new Error('Vault tree changed during listing; start this folder listing again.');
      }
      if (current.index === current.childCount) { frames.pop(); continue; }
      if (entries.length === limit || inspected === TREE_SCAN_LIMIT) break;
      const child = current.folder.children[current.index++];
      inspected++;
      if (!(child instanceof TFile || child instanceof TFolder)) continue;
      try { validateVaultPath(child.path, this.app.vault.configDir); } catch { continue; }
      if (child instanceof TFolder) {
        entries.push({ path: child.path, type: 'folder' });
        if (current.level + 1 < depth) frames.push(frame(child, current.level + 1));
        else depthLimitReached = true;
      } else {
        entries.push({ path: child.path, type: 'file', extension: child.extension });
      }
    }
    checkAbort(signal);
    if (run !== this.run) throw new Error('File tree listing cancelled; start it again.');
    if (cursor !== undefined) this.treePages.delete(cursor);
    let nextCursor: string | null = null;
    if (frames.length) {
      nextCursor = crypto.randomUUID();
      if (this.treePages.size >= TREE_CURSOR_LIMIT) this.treePages.delete(this.treePages.keys().next().value!);
      this.treePages.set(nextCursor, { path, depth, frames });
    }
    return result({
      path, root: path === '', depth, limit, entries, truncated: nextCursor !== null, nextCursor,
      depthLimitReached,
      scope: 'Visible files and folders only, in native child order. Pagination covers the requested depth only; query a folder directly for deeper children. Live tree: restart after vault changes. Cursors are single-use and expire when the run ends.',
    });
  }
  private async search(query: string, limit: number, signal?: AbortSignal) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Search limit must be between 1 and 50.');
    const needle = query.toLowerCase();
    const results: { path: string; snippet: string }[] = [];
    let skippedOversized = 0;
    let inspected = 0;
    const files = this.app.vault.getMarkdownFiles().sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    for (const file of files) {
      checkAbort(signal);
      try { this.notePath(file.path); } catch { continue; }
      if (inspected++ % 10 === 0) { await delay(0); checkAbort(signal); }
      const pathMatches = file.path.toLowerCase().includes(needle);
      if (!needle) { results.push({ path: file.path, snippet: '' }); }
      else {
        let content: string;
        try { content = await this.app.vault.cachedRead(file); } catch { throw new Error('Unable to read a note during search.'); }
        checkAbort(signal);
        if (content.length > MAX_NOTE_CHARACTERS) {
          skippedOversized++;
          if (pathMatches) results.push({ path: file.path, snippet: '' });
        } else {
          const position = content.toLowerCase().indexOf(needle);
          if (pathMatches || position >= 0) results.push({ path: file.path, snippet: content.slice(Math.max(0, position - 100), Math.max(0, position - 100) + 300) });
        }
      }
      if (results.length === limit) break;
    }
    return result({ results, skippedOversized, limit, scope: 'Visible Markdown notes; oversized bodies are skipped. Search stops when the result limit is reached.' });
  }
  private async edit(rawPath: string, oldText: string, newText: string, signal?: AbortSignal) {
    checkAbort(signal);
    const path = this.notePath(rawPath);
    const snapshot = this.snapshots.get(path);
    if (!snapshot) throw new Error('Read this note with read_note in the current run before proposing an edit.');
    if (!oldText) throw new Error('The text to replace must be nonempty and occur exactly once.');
    const index = snapshot.content.indexOf(oldText);
    if (index < 0 || snapshot.content.indexOf(oldText, index + 1) >= 0) throw new Error('The text to replace must occur exactly once in the read snapshot.');
    const after = snapshot.content.slice(0, index) + newText + snapshot.content.slice(index + oldText.length);
    bounded(after);
    if (after === snapshot.content) return result({ outcome: 'unchanged', path });
    const run = this.run;
    if (snapshot.file.path !== path || this.app.vault.getFileByPath(path) !== snapshot.file) throw new Error(STALE);
    const decision = await this.approval.request(Object.freeze({ kind: 'note-change', operation: 'edit', path, before: snapshot.content, after }), signal);
    if (signal?.aborted || run !== this.run) return result({ outcome: 'cancelled', path });
    if (decision !== 'approve') return result({ outcome: 'rejected', path });
    if (snapshot.file.path !== path || this.app.vault.getFileByPath(path) !== snapshot.file) throw new Error(STALE);
    try {
      await this.app.vault.process(snapshot.file, current => {
        checkAbort(signal);
        if (run !== this.run || snapshot.file.path !== path || this.app.vault.getFileByPath(path) !== snapshot.file || current !== snapshot.content) throw new Error(STALE);
        this.app.workspace.iterateAllLeaves(leaf => {
          const view = leaf.view;
          if (view instanceof MarkdownView && view.file === snapshot.file && view.editor.getValue() !== current) throw new Error(STALE);
        });
        return after;
      });
    } catch (error) {
      if (error instanceof Error && (error.message === STALE || error.message === 'Operation cancelled.')) throw error;
      throw new Error('Unable to apply the approved note edit. Read the note to inspect its current state.');
    }
    // An abort after the atomic write starts does not undo a committed edit.
    if (run === this.run) this.snapshots.set(path, { file: snapshot.file, path, content: after });
    return result({ outcome: 'applied', operation: 'edit', path });
  }
  private async create(rawPath: string, content: string, signal?: AbortSignal) {
    checkAbort(signal);
    const path = this.notePath(rawPath);
    bounded(content); this.checkCreate(path);
    const run = this.run;
    const decision = await this.approval.request(Object.freeze({ kind: 'note-change', operation: 'create', path, before: '', after: content }), signal);
    if (signal?.aborted || run !== this.run) return result({ outcome: 'cancelled', path });
    if (decision !== 'approve') return result({ outcome: 'rejected', path });
    checkAbort(signal); this.checkCreate(path);
    try { await this.app.vault.create(path, content); }
    catch { throw new Error('Unable to create the approved note; its path may now exist. No existing note was overwritten.'); }
    return result({ outcome: 'applied', operation: 'create', path });
  }
}
