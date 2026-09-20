import { App, Modal } from "obsidian";
import type { Attachment } from "../agent/attachments";

export class AttachmentPreviewModal extends Modal {
 constructor(app: App, private readonly attachment: Attachment) { super(app); }
 onOpen(): void {
  this.contentEl.empty();
  this.contentEl.addClass("obsidiai-attachment-preview");
  const attachment = this.attachment;
  this.titleEl.textContent = attachment.path;
  this.contentEl.createEl("p", {
   text: attachment.kind === "image" ? attachment.mimeType : attachment.kind === "note" ? "Vault note snapshot" : "Text attachment (UTF-8)"
  });
  if (attachment.kind === "image") {
   if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mimeType) || /[^A-Za-z0-9+/=]/.test(attachment.data)) {
    this.contentEl.createEl("p", { text: "This image attachment cannot be previewed safely." });
    return;
   }
   const image = this.contentEl.createEl("img", { cls: "obsidiai-attachment-preview-image", attr: { alt: attachment.path } });
   image.onerror = () => {
    image.remove();
    this.contentEl.createEl("p", { text: "This image could not be decoded for preview." });
   };
   image.src = `data:${attachment.mimeType};base64,${attachment.data}`;
  } else {
   this.contentEl.createEl("pre", { cls: "obsidiai-attachment-preview-text", text: attachment.content });
  }
 }
 onClose(): void {
  const image = this.contentEl.querySelector("img");
  if (image) image.onerror = null;
  this.contentEl.empty();
 }
}
