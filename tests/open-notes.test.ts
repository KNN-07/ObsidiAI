import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
 MarkdownView: class {},
 TFile: class {},
 TFolder: class {},
}));
import { MarkdownView, TFile } from "obsidian";
import type { App, WorkspaceLeaf } from "obsidian";
import { captureOpenNotes, openNotePaths } from "../src/vault/open-notes";
import { MAX_NOTE_CHARACTERS } from "../src/agent/vault-tools";

function fixture() {
 const files = new Map<string, TFile>();
 const contents = new Map<TFile, string>();
 const leaves: WorkspaceLeaf[] = [];
 const add = (path: string, content = "saved") => {
  const file = Object.assign(new TFile(), { path, stat: { mtime: 1, size: content.length, ctime: 1 } });
  files.set(path, file); contents.set(file, content); return file;
 };
 const open = (file: TFile, mode = "source", value = contents.get(file)!) => {
  let text = value;
  const view = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, { file, getMode: () => mode, editor: { getValue: () => text } });
  const leaf = { view, isDeferred: false } as unknown as WorkspaceLeaf;
  leaves.push(leaf);
  return { view, leaf, edit: (value: string) => { text = value; } };
 };
 const read = vi.fn(async (file: TFile) => contents.get(file)!);
 const app = {
  vault: { configDir: "Config", getFileByPath: (path: string) => files.get(path) ?? null, read },
  workspace: { iterateAllLeaves: (callback: (leaf: WorkspaceLeaf) => void) => leaves.forEach(callback) },
 } as unknown as App;
 return { app, add, open, files, contents, leaves, read };
}

describe("automatic open note context", () => {
 it("captures current unsaved editor text once, preferring the most recently active split", async () => {
  const f = fixture(); const file = f.add("Note.md");
  f.open(file, "preview"); f.open(file, "source", "older split");
  f.open(file, "source", "another older split");
  const recent = f.open(file, "source", "draft"); recent.edit("latest unsaved text");
  expect(openNotePaths(f.app)).toEqual(["Note.md"]);
  expect(await captureOpenNotes(f.app, [], recent.view)).toEqual([{ path: "Note.md", content: "latest unsaved text" }]);
  expect(f.read).not.toHaveBeenCalled();
 });
 it("includes only open allowed Markdown paths and respects manual and removed-chip exclusions", async () => {
  const f = fixture();
  for (const path of ["Open.md", "Manual.md", "Removed.md", ".hidden/Private.md", "Config/Secret.md", "../Escape.md", "image.png"]) f.open(f.add(path));
  f.add("Unopened.md");
  expect(openNotePaths(f.app)).toEqual(["Manual.md", "Open.md", "Removed.md"]);
  expect(await captureOpenNotes(f.app, ["Manual.md", "Removed.md"])).toEqual([{ path: "Open.md", content: "saved" }]);
 });
 it("reads preview and explicitly Markdown deferred leaves without loading them", async () => {
  const f = fixture(); f.open(f.add("Preview.md", "preview disk"), "preview", "not an editable buffer");
  f.add("Deferred.md", "deferred disk"); f.add("Other.md");
  f.leaves.push({ view: {}, isDeferred: true, getViewState: () => ({ type: "markdown", state: { file: "Deferred.md" } }) } as unknown as WorkspaceLeaf);
  f.leaves.push({ view: {}, isDeferred: true, getViewState: () => ({ type: "canvas", state: { file: "Other.md" } }) } as unknown as WorkspaceLeaf);
  expect(await captureOpenNotes(f.app, [])).toEqual([{ path: "Deferred.md", content: "deferred disk" }, { path: "Preview.md", content: "preview disk" }]);
 });
 it("rejects an oversized editor rather than truncating or omitting it", async () => {
  const f = fixture(); f.open(f.add("Large.md"), "source", "x".repeat(MAX_NOTE_CHARACTERS + 1));
  await expect(captureOpenNotes(f.app, [])).rejects.toThrow("200,000-character limit");
  expect(await captureOpenNotes(f.app, ["Large.md"])).toEqual([]);
 });
 it.each(["editor", "replaced", "closed", "renamed", "disk"])("rejects %s changes across an asynchronous read", async kind => {
  const f = fixture(); const file = f.add("A.md"); const note = f.open(file);
  const disk = f.add("B.md"); f.open(disk, "preview");
  f.read.mockImplementation(async target => {
   if (kind === "editor") note.edit("changed while reading");
   if (kind === "replaced") f.add("A.md", "replacement");
   if (kind === "closed") f.leaves.splice(0, 1);
   if (kind === "renamed") { f.files.delete("A.md"); file.path = "Renamed.md"; f.files.set(file.path, file); }
   if (kind === "disk") disk.stat.mtime++;
   return f.contents.get(target)!;
  });
  await expect(captureOpenNotes(f.app, [])).rejects.toThrow("context changed");
 });
 it("fails safely for conflicting split buffers with no known recent editor", async () => {
  const f = fixture(); const file = f.add("Note.md"); f.open(file, "source", "first"); f.open(file, "source", "second");
  await expect(captureOpenNotes(f.app, [])).rejects.toThrow("context changed");
 });
});
