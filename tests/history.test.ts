import { describe, expect, it } from "vitest";
import { HistoryStore, type Conversation } from "../src/agent/history";

function conversation(id: string): Conversation {
 return { id, title: "Private note", createdAt: 1, updatedAt: 2, providerId: "provider", modelId: "model", messages: [{ role: "user", content: "Private note content", timestamp: 1 }], timeline: [{ id: "user", kind: "user", text: "Private note content", complete: true, sourcePath: "Note.md" }] };
}
describe("durable chat history", () => {
 it("serializes a snapshotted batch selection after an in-flight save", async () => {
  let bytes = JSON.stringify({ version: 1, conversations: [conversation("b"), conversation("keep")] });
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let first = true;
  const adapter = { async exists() { return !!bytes; }, async read() { return bytes; }, async write(_path: string, value: string) { if (first) { first = false; entered.resolve(); await gate.promise; } bytes = value; } };
  const store = new HistoryStore(adapter, "history.json");
  const save = store.save(conversation("a")); await entered.promise;
  const ids = ["a", "b"];
  const deletion = store.delete(ids); ids.splice(0, ids.length, "keep");
  gate.resolve(); await save; await deletion;
  expect((await new HistoryStore(adapter, "history.json").list()).map(c => c.id)).toEqual(["keep"]);
  expect((await store.get("keep")).messages).toEqual(conversation("keep").messages);
 });
 it("retains the entire selection after a failed batch save and preserves unselected chats", async () => {
  let bytes = ""; let fail = false;
  const adapter = { async exists() { return !!bytes; }, async read() { return bytes; }, async write(_path: string, value: string) { if (fail) throw new Error("disk full"); bytes = value; } };
  const store = new HistoryStore(adapter, "history.json");
  for (const id of ["a", "b", "keep"]) await store.save(conversation(id));
  fail = true;
  await expect(store.delete(["a", "b"])).rejects.toThrow("history");
  await expect(store.save(conversation("new"))).rejects.toThrow("history");
  expect((await store.list()).map(c => c.id)).toEqual(["a", "b", "keep"]);
  expect((await new HistoryStore(adapter, "history.json").list()).map(c => c.id)).toEqual(["a", "b", "keep"]);
  fail = false; await store.delete(["a", "b"]);
  expect((await new HistoryStore(adapter, "history.json").list()).map(c => c.id)).toEqual(["keep"]);
 });
 it("preserves unreadable existing history rather than replacing it with a new conversation", async () => {
  let bytes = "{broken";
  const store = new HistoryStore({ async exists() { return true; }, async read() { return bytes; }, async write(_path, value) { bytes = value; } }, "history.json");
  await expect(store.list()).rejects.toThrow("history");
  await expect(store.save(conversation("a"))).rejects.toThrow("history");
  expect(bytes).toBe("{broken");
 });
});
