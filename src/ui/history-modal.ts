import { App, ButtonComponent, Modal } from "obsidian";
import type { AgentController } from "../agent/controller";

export class ChatHistoryModal extends Modal {
 private closed = false;
 private unsubscribe?: () => void;
 constructor(app: App, private readonly controller: AgentController) { super(app); }
 onOpen(): void { this.closed = false; this.unsubscribe = this.controller.subscribe(() => { this.contentEl.querySelectorAll("button").forEach(button => button.disabled = !this.controller.idle); }); void this.render(); }
 onClose(): void { this.closed = true; this.unsubscribe?.(); this.contentEl.empty(); }
 private async render(): Promise<void> {
  if (this.closed) return;
  this.contentEl.empty(); this.titleEl.setText("Chat history");
  this.contentEl.createEl("p", { text: "Chats include sent note excerpts, skill instructions and tool results. They are stored in this plugin’s history.json inside the vault configuration folder, unencrypted by this plugin, and may be copied by sync or backups. Deleting removes this plugin’s saved copy, not copies already synced or backed up." });
  this.contentEl.createEl("p", { text: "Opening a chat resets permissions to Ask. Future requests use the provider and model currently selected in Settings, not necessarily the chat’s original model." });
  try {
   const conversations = await this.controller.listHistory();
   if (this.closed) return;
   if (!conversations.length) this.contentEl.createEl("p", { text: "No saved conversations yet. Chats are saved after each settled response." });
   for (const chat of conversations) {
    const row = this.contentEl.createDiv({ cls: "obsidiai-history-entry" });
    row.createEl("h3", { text: chat.title });
    row.createEl("p", { text: `${new Date(chat.updatedAt).toLocaleString()} · ${chat.providerId} / ${chat.modelId}` });
    new ButtonComponent(row).setButtonText("Open").setDisabled(!this.controller.idle).onClick(() => { void this.act(async () => { await this.controller.openConversation(chat.id); this.close(); }); });
    new ButtonComponent(row).setButtonText("Delete").setDisabled(!this.controller.idle).onClick(() => {
     row.empty(); row.createEl("p", { text: `Permanently delete “${chat.title}” from this plugin’s history?` });
     new ButtonComponent(row).setButtonText("Cancel").onClick(() => { void this.render(); }).buttonEl.focus();
     new ButtonComponent(row).setButtonText("Delete permanently").setWarning().onClick(() => { void this.act(async () => { await this.controller.deleteConversation(chat.id); await this.render(); }); });
    });
   }
  } catch { this.contentEl.createEl("p", { text: "Chat history could not be read. Check plugin-folder access and history.json; unreadable history will not be silently replaced.", cls: "obsidiai-error" }); }
 }
 private async act(action: () => Promise<void>): Promise<void> {
  this.contentEl.querySelectorAll("button").forEach(button => button.disabled = true);
  try { await action(); }
  catch (error) {
   if (!this.closed) { await this.render(); this.contentEl.createEl("p", { text: error instanceof Error ? error.message : "Chat history operation failed.", cls: "obsidiai-error" }); }
  }
 }
}
