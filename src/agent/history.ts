import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DataAdapter } from "obsidian";
import type { TimelineItem } from "./controller";
import { resolveAttachments } from "./attachments";

export interface Conversation {
 id: string; title: string; createdAt: number; updatedAt: number;
 providerId: string; modelId: string;
 messages: AgentMessage[]; timeline: TimelineItem[];
}
export type ConversationSummary = Pick<Conversation, "id" | "title" | "createdAt" | "updatedAt" | "providerId" | "modelId">;
export interface ConversationHistory {
 list(): Promise<ConversationSummary[]>;
 get(id: string): Promise<Conversation>;
 save(conversation: Conversation): Promise<void>;
 delete(ids: readonly string[]): Promise<void>;
}
const FAILURE = "Chat history could not be read or saved. Check plugin-folder access and available disk space. Existing history has not been intentionally replaced.";

/** One plugin-local file. Publish memory only after the adapter confirms a write. */
export class HistoryStore implements ConversationHistory {
 private queue: Promise<unknown> = Promise.resolve();
 private records?: Conversation[];
 constructor(private readonly adapter: Pick<DataAdapter, "exists" | "read" | "write">, private readonly path: string) {}
 private operation<T>(action: () => Promise<T>): Promise<T> {
  const result = this.queue.then(async () => {
   try { return await action(); } catch { throw new Error(FAILURE); }
  });
  this.queue = result.catch(() => undefined);
  return result;
 }
 private async load(): Promise<Conversation[]> {
  if (this.records) return this.records;
  if (!await this.adapter.exists(this.path)) return this.records = [];
  const data: unknown = JSON.parse(await this.adapter.read(this.path));
  if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1 || !("conversations" in data) || !Array.isArray(data.conversations)) throw new Error("Invalid history");
  const ids = new Set<string>();
  for (const c of data.conversations) {
   if (!c || typeof c.id !== "string" || ids.has(c.id) || typeof c.title !== "string" || !Number.isFinite(c.createdAt) || !Number.isFinite(c.updatedAt) || typeof c.providerId !== "string" || typeof c.modelId !== "string" || !Array.isArray(c.messages) || !Array.isArray(c.timeline)) throw new Error("Invalid conversation");
   if (c.messages.some((m: Record<string, unknown>) => !m || !["user", "assistant", "toolResult"].includes(String(m.role)) || !(typeof m.content === "string" || Array.isArray(m.content)))) throw new Error("Invalid messages");
   if (c.timeline.some((t: Record<string, unknown>) => !t || typeof t.id !== "string" || !["user", "assistant", "tool", "error"].includes(String(t.kind)) || typeof t.text !== "string" || typeof t.sourcePath !== "string" || typeof t.complete !== "boolean")) throw new Error("Invalid timeline");
   if (c.timeline.some((t: Record<string, unknown>) => [t.attachmentPaths, t.skillNames].some(value => value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== "string"))))) throw new Error("Invalid displayed context");
   for (const item of c.timeline) {
    if (item.attachmentReferences !== undefined) {
     if (item.kind !== "user") throw new Error("Invalid attachment timeline item");
     resolveAttachments(item.attachmentReferences, c.messages);
    }
   }
   ids.add(c.id);
  }
  return this.records = data.conversations;
 }
 list(): Promise<ConversationSummary[]> {
  return this.operation(async () => (await this.load()).map(({ id, title, createdAt, updatedAt, providerId, modelId }) => ({ id, title, createdAt, updatedAt, providerId, modelId })).sort((a, b) => b.updatedAt - a.updatedAt));
 }
 get(id: string): Promise<Conversation> { return this.operation(async () => { const item = (await this.load()).find(c => c.id === id); if (!item) throw new Error("Missing conversation"); return structuredClone(item); }); }
 save(conversation: Conversation): Promise<void> {
  // Snapshot before joining the queue: later caller mutations cannot change this write.
  const copy = structuredClone(conversation);
  return this.operation(async () => {
   for (const item of copy.timeline) {
    if (item.attachmentReferences !== undefined) {
     if (item.kind !== "user") throw new Error("Invalid attachment timeline item");
     resolveAttachments(item.attachmentReferences, copy.messages);
    }
   }
   const next = (await this.load()).filter(c => c.id !== copy.id); next.push(copy); await this.persist(next);
  });
 }
 delete(ids: readonly string[]): Promise<void> {
  const selected = new Set(ids);
  if (!selected.size) return Promise.resolve();
  return this.operation(async () => {
   const records = await this.load();
   const next = records.filter(c => !selected.has(c.id));
   if (next.length !== records.length) await this.persist(next);
  });
 }
 private async persist(next: Conversation[]): Promise<void> {
  await this.adapter.write(this.path, JSON.stringify({ version: 1, conversations: next }));
  this.records = next;
 }
}
