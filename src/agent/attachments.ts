import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Buffer } from "node:buffer";

export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
export type AttachmentInput = { kind: "note" | "text"; path: string; content: string } | { kind: "image"; path: string; data: string; mimeType: ImageMime };
export type Attachment = AttachmentInput & { id: string };
export interface AttachmentReference { id: string; kind: AttachmentInput["kind"]; path: string; messageIndex: number; blockIndex: number; }
export const MAX_TEXT_CHARACTERS = 200_000;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;
const IMAGE_MIMES: Record<string, true> = { "image/png": true, "image/jpeg": true, "image/webp": true, "image/gif": true };

/** External files never retain their operating-system location. */
export function normalizeAttachment(input: AttachmentInput): AttachmentInput {
 const path = input.kind === "note" ? input.path : input.path.split(/[\\/]/).at(-1)!;
 const result = { ...input, path };
 attachmentBytes(result);
 return result;
}
export function attachmentBytes(input: AttachmentInput): number {
 if (!input || !["note", "text", "image"].includes(input.kind) || typeof input.path !== "string" || !input.path || /[\x00-\x1f\x7f]/.test(input.path)) throw new Error("Invalid attachment name.");
 if (input.kind === "note") {
  if (input.path.includes("\\") || input.path.includes(":") || input.path.split("/").some(part => !part || part.startsWith("."))) throw new Error("Invalid note attachment path.");
 } else if (/[\\/:]/.test(input.path) || input.path === "." || input.path === "..") throw new Error("External attachments require a filename only.");
 if (input.kind !== "image") {
  if (typeof input.content !== "string" || input.content.length > MAX_TEXT_CHARACTERS) throw new Error("Attachment exceeds 200,000 characters; it was not attached.");
  return Buffer.byteLength(input.content, "utf8");
 }
 if (!Object.hasOwn(IMAGE_MIMES, input.mimeType) || typeof input.data !== "string" || !input.data.length || input.data.length % 4 !== 0 || input.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new Error("Invalid or oversized image attachment. Use PNG, JPEG, WebP, or GIF up to 5 MiB.");
 const bytes = input.data.length / 4 * 3 - (input.data.endsWith("==") ? 2 : input.data.endsWith("=") ? 1 : 0);
 if (bytes > MAX_IMAGE_BYTES) throw new Error("Image attachment exceeds 5 MiB.");
 return bytes;
}
export function validateAttachments(inputs: readonly AttachmentInput[]): void {
 if (inputs.length > MAX_ATTACHMENTS) throw new Error("Attach at most 20 files per message.");
 if (inputs.reduce((sum, input) => sum + attachmentBytes(input), 0) > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error("Attachments exceed the 20 MiB total limit.");
}

/** Resolve only well-formed user-message references, never arbitrary history fields. */
export function resolveAttachments(references: unknown, messages: readonly AgentMessage[]): Attachment[] {
 if (!Array.isArray(references) || references.length > MAX_ATTACHMENTS) throw new Error("Invalid attachment references.");
 const ids = new Set<string>();
 const attachments = references.map((ref: AttachmentReference) => {
  if (!ref || typeof ref.id !== "string" || !ref.id || ref.id.length > 128 || ids.has(ref.id) || !Number.isSafeInteger(ref.messageIndex) || ref.messageIndex < 0 || !Number.isSafeInteger(ref.blockIndex) || ref.blockIndex < 0) throw new Error("Invalid attachment reference.");
  ids.add(ref.id);
  const message = messages[ref.messageIndex];
  const block = message?.role === "user" && Array.isArray(message.content) ? message.content[ref.blockIndex] : undefined;
  let attachment: Attachment;
  if (ref.kind === "image" && block?.type === "image") attachment = { id: ref.id, kind: ref.kind, path: ref.path, data: block.data, mimeType: block.mimeType as ImageMime };
  else if ((ref.kind === "note" || ref.kind === "text") && block?.type === "text") attachment = { id: ref.id, kind: ref.kind, path: ref.path, content: block.text };
  else throw new Error("Invalid attachment content reference.");
  return attachment;
 });
 validateAttachments(attachments);
 return attachments;
}
