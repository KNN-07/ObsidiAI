import { beforeEach, describe, expect, it, vi } from 'vitest';

const ui = vi.hoisted(() => ({ buttons: [] as { text: string; click: () => void }[], modals: [] as { close: () => void }[] }));
vi.mock('obsidian', () => {
  interface MockElement { createEl: () => MockElement; createDiv: () => MockElement; empty: () => void; focus: () => void }
  const element = (): MockElement => ({ createEl: element, createDiv: element, empty() {}, focus() {} });
  return {
    App: class {},
    TFile: class { constructor(public path: string) {} },
    TFolder: class { constructor(public path: string) {} },
    MarkdownView: class {},
    Modal: class {
      contentEl = element();
      constructor() { ui.modals.push(this); }
      setTitle() { return this; }
      onOpen() {}
      onClose() {}
      open() { this.onOpen(); }
      close() { this.onClose(); }
    },
    ButtonComponent: class {
      buttonEl = element();
      button = { text: '', click: () => {} };
      constructor() { ui.buttons.push(this.button); }
      setButtonText(text: string) { this.button.text = text; return this; }
      setCta() { return this; }
      onClick(click: () => void) { this.button.click = click; return this; }
    },
  };
});
vi.mock('../src/ui/plugin-approval-modal', () => ({ PluginApprovalModal: class {} }));
import { MarkdownView, TFile, TFolder, type App } from 'obsidian';
import { ApprovalController } from '../src/ui/approval-modal';
import { VaultToolService, MAX_NOTE_CHARACTERS } from '../src/agent/vault-tools';
import { validateVaultPath } from '../src/vault/paths';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

function fixture() {
  const files = new Map<string, TFile>();
  const contents = new Map<TFile, string>();
  const root = Object.assign(new TFolder(), { path: '' });
  const folders = new Map([['Projects', Object.assign(new TFolder(), { path: 'Projects' })]]);
  const leaves: { view: unknown }[] = [];
  const add = (path: string, content: string) => {
    const file = Object.assign(new TFile(), { path });
    files.set(path, file); contents.set(file, content); return file;
  };
  const alpha = add('Projects/Alpha.md', '# Alpha\nStatus: draft\n');
  let afterCommit: (() => void) | undefined;
  const app = {
    vault: {
      configDir: '.obsidian',
      getFileByPath: (path: string) => files.get(path) ?? null,
      getAbstractFileByPath: (path: string) => files.get(path) ?? folders.get(path) ?? null,
      getRoot: () => root,
      getMarkdownFiles: () => [...files.values()],
      read: async (file: TFile) => contents.get(file)!,
      cachedRead: async (file: TFile) => contents.get(file)!,
      process: async (file: TFile, update: (before: string) => string) => {
        const next = update(contents.get(file)!);
        contents.set(file, next); afterCommit?.(); return next;
      },
      create: async (path: string, content: string) => {
        if (files.has(path)) throw new Error('Collision');
        const file = add(path, content); afterCommit?.(); return file;
      },
    },
    workspace: { iterateAllLeaves: (callback: (leaf: { view: unknown }) => void) => leaves.forEach(callback) },
  } as unknown as App;
  const approval = new ApprovalController(app);
  const service = new VaultToolService(app, approval);
  service.beginRun();
  const call = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => service.tools.find(tool => tool.name === name)!.execute('call', args, signal);
  const edit = (signal?: AbortSignal) => call('propose_note_edit', { path: alpha.path, oldText: 'Status: draft', newText: 'Status: reviewed' }, signal);
  const read = () => call('read_note', { path: alpha.path });
  return { app, alpha, files, contents, leaves, approval, service, call, edit, read, add, afterCommit: (callback: () => void) => { afterCommit = callback; } };
}
function click(text: string) { ui.buttons.findLast(button => button.text === text)!.click(); }
beforeEach(() => { ui.buttons.length = 0; ui.modals.length = 0; });

describe('approval-bound note operations', () => {
  it('runs the real Agent read-propose-observe loop through native approval', async () => {
    const f = fixture();
    const faux = fauxProvider({ tokensPerSecond: 100000 });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('read_note', { path: f.alpha.path })),
      fauxAssistantMessage(fauxToolCall('propose_note_edit', { path: f.alpha.path, oldText: 'Status: draft', newText: 'Status: reviewed' })),
      context => {
        const outcome = context.messages.findLast(message => message.role === 'toolResult');
        expect(outcome?.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('"outcome":"applied"') })]));
        return fauxAssistantMessage('Approved edit applied.');
      },
    ]);
    const agent = new Agent({ initialState: { model: faux.getModel(), tools: f.service.tools }, streamFn: models.streamSimple.bind(models), toolExecution: 'sequential' });
    const waiting = Promise.withResolvers<void>();
    const unsubscribe = f.approval.subscribe(pending => { if (pending) waiting.resolve(); });
    const run = agent.prompt('Read Alpha and review its status.');
    await waiting.promise;
    expect(f.contents.get(f.alpha)).toBe('# Alpha\nStatus: draft\n');
    click('Approve'); await run; await agent.waitForIdle(); unsubscribe();
    expect(f.contents.get(f.alpha)).toBe('# Alpha\nStatus: reviewed\n');
    expect(agent.state.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'stop' });
  });
  it('writes only after approval and refreshes the current-run snapshot', async () => {
    const f = fixture(); await f.read(); const pending = f.edit();
    expect(f.contents.get(f.alpha)).toBe('# Alpha\nStatus: draft\n');
    click('Approve'); expect((await pending).details).toMatchObject({ outcome: 'applied' });
    expect(f.contents.get(f.alpha)).toBe('# Alpha\nStatus: reviewed\n');
    const second = f.call('propose_note_edit', { path: f.alpha.path, oldText: 'reviewed', newText: 'done' });
    click('Approve'); await second; expect(f.contents.get(f.alpha)).toBe('# Alpha\nStatus: done\n');
  });
  it.each(['Reject', 'abort', 'close', 'cancelAll'])('settles %s with unchanged bytes and ignores late approval', async mode => {
    const f = fixture(); await f.read(); const abort = new AbortController(); const pending = f.edit(abort.signal);
    const late = ui.buttons.find(button => button.text === 'Approve')!.click;
    if (mode === 'Reject') click('Reject'); else if (mode === 'abort') abort.abort(); else if (mode === 'close') ui.modals[0].close(); else f.approval.cancelAll();
    late(); expect((await pending).details.outcome).toBe(mode === 'abort' ? 'cancelled' : 'rejected');
    expect(f.contents.get(f.alpha)).toBe('# Alpha\nStatus: draft\n');
    const next = f.edit(); click('Approve'); expect((await next).details.outcome).toBe('applied');
  });
  it.each(['persisted', 'editor', 'deleted', 'replaced', 'renamed'])('rejects a %s target change during review', async kind => {
    const f = fixture(); await f.read(); const pending = f.edit();
    const failure = expect(pending).rejects.toThrow('Note changed since review');
    if (kind === 'persisted') f.contents.set(f.alpha, 'user edit');
    if (kind === 'editor') f.leaves.push({ view: Object.assign(new MarkdownView({} as never), { file: f.alpha, editor: { getValue: () => 'unsaved user edit' } }) });
    if (kind === 'deleted') f.files.delete(f.alpha.path);
    if (kind === 'replaced') f.add(f.alpha.path, 'replacement');
    if (kind === 'renamed') { f.files.delete(f.alpha.path); f.alpha.path = 'Projects/Renamed.md'; f.files.set(f.alpha.path, f.alpha); }
    click('Approve'); await failure;
    expect(f.contents.get(f.alpha)).toBe(kind === 'persisted' ? 'user edit' : '# Alpha\nStatus: draft\n');
  });
  it('requires a current-run snapshot and unique nonempty replacement', async () => {
    const f = fixture(); await expect(f.edit()).rejects.toThrow('current run');
    f.contents.set(f.alpha, 'aaaa'); await f.read();
    for (const oldText of ['', 'aa', 'missing']) await expect(f.call('propose_note_edit', { path: f.alpha.path, oldText, newText: 'x' })).rejects.toThrow('exactly once');
    expect(ui.modals).toHaveLength(0); expect(f.contents.get(f.alpha)).toBe('aaaa');
    f.service.endRun(); f.service.beginRun(); await expect(f.edit()).rejects.toThrow('current run');
  });
  it('returns unchanged for no-op and rejects oversized notes and proposals without approval', async () => {
    const f = fixture(); await f.read();
    expect((await f.call('propose_note_edit', { path: f.alpha.path, oldText: 'draft', newText: 'draft' })).details.outcome).toBe('unchanged');
    await expect(f.call('propose_note_edit', { path: f.alpha.path, oldText: 'draft', newText: 'x'.repeat(MAX_NOTE_CHARACTERS) })).rejects.toThrow('200,000');
    f.contents.set(f.alpha, 'x'.repeat(MAX_NOTE_CHARACTERS + 1));
    await expect(f.read()).rejects.toThrow('200,000');
    await expect(f.call('propose_note_create', { path: 'Projects/New.md', content: 'x'.repeat(MAX_NOTE_CHARACTERS + 1) })).rejects.toThrow('200,000');
    expect(ui.modals).toHaveLength(0);
  });
  it('creates exact approved bytes and preserves an independently created collision', async () => {
    const f = fixture(); const pending = f.call('propose_note_create', { path: 'Projects/New.md', content: '# New\n' });
    expect(f.files.has('Projects/New.md')).toBe(false); click('Approve'); await pending;
    expect(f.contents.get(f.files.get('Projects/New.md')!)).toBe('# New\n');
    const collision = f.call('propose_note_create', { path: 'Projects/Other.md', content: 'proposal' });
    const failure = expect(collision).rejects.toThrow('already exists');
    const other = f.add('Projects/Other.md', 'independent'); click('Approve'); await failure;
    expect(f.contents.get(other)).toBe('independent');
  });
  it.each(['reject', 'abort', 'end-run'])('does not create a note after %s, even with a late approval', async mode => {
    const f = fixture(); const abort = new AbortController();
    const pending = f.call('propose_note_create', { path: 'Projects/New.md', content: 'proposal' }, abort.signal);
    const late = ui.buttons.findLast(button => button.text === 'Approve')!.click;
    if (mode === 'reject') click('Reject');
    else if (mode === 'abort') abort.abort();
    else f.service.endRun();
    late();
    expect((await pending).details.outcome).toBe(mode === 'reject' ? 'rejected' : 'cancelled');
    expect(f.files.has('Projects/New.md')).toBe(false);
  });
  it('rechecks the parent after creation approval', async () => {
    const f = fixture();
    const pending = f.call('propose_note_create', { path: 'Projects/New.md', content: 'proposal' });
    const failure = expect(pending).rejects.toThrow('parent folder');
    f.add('Projects', 'now a file');
    click('Approve'); await failure;
    expect(f.files.has('Projects/New.md')).toBe(false);
  });
  it('rejects missing parent and occupied paths before approval', async () => {
    const f = fixture();
    await expect(f.call('propose_note_create', { path: 'Missing/New.md', content: '' })).rejects.toThrow('parent folder');
    await expect(f.call('propose_note_create', { path: f.alpha.path, content: '' })).rejects.toThrow('already exists');
    expect(ui.modals).toHaveLength(0);
  });
  it('records committed writes as applied even if Stop arrives after commit', async () => {
    const f = fixture(); const abort = new AbortController(); await f.read(); f.afterCommit(() => abort.abort());
    const pending = f.edit(abort.signal); click('Approve');
    expect((await pending).details.outcome).toBe('applied'); expect(f.contents.get(f.alpha)).toContain('reviewed');
  });
  it('allows only one pending approval', async () => {
    const f = fixture(); await f.read(); const first = f.edit();
    await expect(f.edit()).rejects.toThrow('already pending'); click('Reject'); await first;
  });
});

describe('visible path boundary and bounded search', () => {
  it.each(['/absolute.md', 'C:/drive.md', '\\\\server\\note.md', 'a\\note.md', 'https://host/note.md', 'a//note.md', './note.md', 'a/../note.md', '.secret/note.md', '.obsidian/note.md', 'a/\0.md', 'a/', ''])('rejects unsafe path %s', async path => {
    const f = fixture(); expect(() => validateVaultPath(path, '.obsidian')).toThrow();
    await expect(f.call('propose_note_create', { path, content: '' })).rejects.toThrow(); expect(ui.modals).toHaveLength(0);
  });
  it('protects custom config folders and rejects non-Markdown targets', async () => {
    expect(() => validateVaultPath('Config/note.md', 'Config')).toThrow();
    expect(validateVaultPath('Configuration/note.md', 'Config')).toBe('Configuration/note.md');
    await expect(fixture().call('read_note', { path: 'plain.txt' })).rejects.toThrow('Markdown');
  });
  it('matches literals case-insensitively with bounded snippets and skips oversized bodies', async () => {
    const f = fixture(); f.contents.set(f.alpha, `${'a'.repeat(500)}[Literal]${'b'.repeat(500)}`);
    f.add('Projects/Huge.md', 'x'.repeat(MAX_NOTE_CHARACTERS + 1));
    f.add('.hidden/Hidden.md', '[literal]');
    const data = (await f.call('search_notes', { query: '[LITERAL]' })).details;
    expect(data.results).toEqual([{ path: f.alpha.path, snippet: `${'a'.repeat(100)}[Literal]${'b'.repeat(191)}` }]);
    expect(data.skippedOversized).toBe(1);
    expect((await f.call('search_notes', { query: 'huge' })).details.results).toEqual([{ path: 'Projects/Huge.md', snippet: '' }]);
    expect((await f.call('search_notes', { query: 'absent' })).details.results).toEqual([]);
    expect((await f.call('search_notes', { query: '', limit: 1 })).details.results).toEqual([{ path: f.alpha.path, snippet: '' }]);
  });
  it('honors cancellation during incremental search', async () => {
    const f = fixture(); const abort = new AbortController(); const pending = f.call('search_notes', { query: 'draft' }, abort.signal);
    abort.abort(); await expect(pending).rejects.toThrow('cancelled');
  });
});
