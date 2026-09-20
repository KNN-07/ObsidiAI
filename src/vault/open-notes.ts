import { MarkdownView, TFile, type App, type WorkspaceLeaf } from "obsidian";
import { validateVaultPath } from "./paths";

interface OpenNote {
 path: string;
 file: TFile;
 leaf: WorkspaceLeaf;
 editor: MarkdownView | null;
 conflicting?: boolean;
}
const CHANGED = "Open note context changed while preparing the message. Review the open notes and send again.";

/** Inspect only open leaves; never load deferred views or enumerate the vault. */
function openNotes(app: App, excludedPaths: readonly string[], preferred: MarkdownView | null): OpenNote[] {
 const excluded = new Set(excludedPaths);
 const notes = new Map<string, OpenNote>();
 app.workspace.iterateAllLeaves(leaf => {
  const view = leaf.view;
  let file: TFile | null = null;
  let editor: MarkdownView | null = null;
  if (view instanceof MarkdownView) {
   file = view.file;
   if (view.getMode() === "source") editor = view;
  } else if (leaf.isDeferred) {
   const state = leaf.getViewState();
   if (state.type === "markdown" && typeof state.state?.file === "string") file = app.vault.getFileByPath(state.state.file);
  }
  if (!(file instanceof TFile) || !file.path.toLowerCase().endsWith(".md") || excluded.has(file.path)) return;
  try { validateVaultPath(file.path, app.vault.configDir); } catch { return; }
  if (app.vault.getFileByPath(file.path) !== file) throw new Error(CHANGED);
  const prior = notes.get(file.path);
  if (!prior || (editor && (!prior.editor || editor === preferred))) notes.set(file.path, { path: file.path, file, leaf, editor });
  else if (editor && prior.editor && prior.editor !== preferred && editor.editor.getValue() !== prior.editor.editor.getValue()) prior.conflicting = true;
 });
 // A preferred split may appear after conflicting older splits in workspace order.
 for (const note of notes.values()) if (note.conflicting) throw new Error(CHANGED);
 return [...notes.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function openNotePaths(app: App): string[] {
 // Preview needs paths only, so editor disagreement must not hide a chip.
 const paths = new Set<string>();
 app.workspace.iterateAllLeaves(leaf => {
  const state = leaf.isDeferred ? leaf.getViewState() : null;
  const file = leaf.view instanceof MarkdownView ? leaf.view.file
   : state?.type === "markdown" && typeof state.state?.file === "string" ? app.vault.getFileByPath(state.state.file) : null;
  if (!(file instanceof TFile) || !file.path.toLowerCase().endsWith(".md")) return;
  try { validateVaultPath(file.path, app.vault.configDir); } catch { return; }
  if (app.vault.getFileByPath(file.path) === file) paths.add(file.path);
 });
 return [...paths].sort((a, b) => a.localeCompare(b));
}

export async function captureOpenNotes(app: App, excludedPaths: readonly string[], preferred: MarkdownView | null = null): Promise<{ path: string; content: string }[]> {
 // Keep pi/tool imports behind the desktop runtime boundary, even for path previews.
 const { MAX_NOTE_CHARACTERS } = await import("../agent/vault-tools");
 const notes = openNotes(app, excludedPaths, preferred);
 const captured: { path: string; content: string }[] = [];
 const snapshots = notes.map(note => ({ mtime: note.file.stat.mtime, size: note.file.stat.size, content: note.editor?.editor.getValue() }));
 for (let index = 0; index < notes.length; index++) {
  const note = notes[index]!;
  const snapshot = snapshots[index]!;
  let content: string;
  try { content = snapshot.content ?? await app.vault.read(note.file); }
  catch { throw new Error(`Could not capture open note: ${note.path}. Nothing was sent.`); }
  if (content.length > MAX_NOTE_CHARACTERS) throw new Error(`Open note ${note.path} exceeds the 200,000-character limit. Exclude it before sending.`);
  captured.push({ path: note.path, content });
 }
 const current = openNotes(app, excludedPaths, preferred);
 if (current.length !== notes.length) throw new Error(CHANGED);
 for (let index = 0; index < notes.length; index++) {
  const note = notes[index]!;
  const now = current[index]!;
  const snapshot = snapshots[index]!;
  if (now.path !== note.path || now.file !== note.file || now.leaf !== note.leaf || now.editor !== note.editor
   || note.file.path !== note.path || app.vault.getFileByPath(note.path) !== note.file
   || (note.editor ? note.editor.editor.getValue() !== snapshot.content : note.file.stat.mtime !== snapshot.mtime || note.file.stat.size !== snapshot.size)) throw new Error(CHANGED);
 }
 return captured;
}
