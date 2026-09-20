import { ButtonComponent, Component, setIcon } from "obsidian";
import type { AgentController } from "../agent/controller";
import type { ConversationSummary } from "../agent/history";

export class ChatHistoryView extends Component {
 private conversations: ConversationSummary[] = [];
 private visibleConversations: ConversationSummary[] = [];
 private generation = 0;
 private busy = false;
 private loading = false;
 private limit = 50;
 private confirming?: string;
 private selecting = false;
 private readonly selected = new Set<string>();
 private matches: ConversationSummary[] = [];
 private pendingDeletion?: readonly string[];
 private selectionBar!: HTMLElement;
 private selectionToggle!: ButtonComponent;
 private selectAllButton?: ButtonComponent;
 private clearSelectionButton?: ButtonComponent;
 private deleteSelectionButton?: ButtonComponent;
 private search!: HTMLInputElement;
 private results!: HTMLElement;
 private count!: HTMLElement;
 private error!: HTMLElement;
 private back!: ButtonComponent;
 private visible = false;
 get isVisible(): boolean { return this.visible; }
 constructor(private readonly container: HTMLElement, private readonly controller: AgentController, private readonly returnToChat: (opened: boolean) => void) { super(); }
 onload(): void {
  this.container.addClass("obsidiai-history"); this.container.hidden = true;
  this.container.setAttrs({ role: "region", "aria-label": "Chat history" });
  const column = this.container.createDiv({ cls: "obsidiai-history-column" });
  const toolbar = column.createDiv({ cls: "obsidiai-history-toolbar" });
  this.back = new ButtonComponent(toolbar).setButtonText("Back to chat").onClick(() => { if (!this.busy) this.returnToChat(false); });
  this.back.buttonEl.addClass("obsidiai-text-button");
  const arrow = this.back.buttonEl.createSpan({ attr: { "aria-hidden": "true" } }); setIcon(arrow, "arrow-left"); this.back.buttonEl.prepend(arrow);
  this.selectionToggle = new ButtonComponent(toolbar).setButtonText("Select chats").onClick(() => this.setSelecting(!this.selecting));
  this.selectionToggle.buttonEl.addClass("obsidiai-text-button");
  this.selectionToggle.buttonEl.setAttr("aria-pressed", "false");
  const heading = column.createDiv({ cls: "obsidiai-history-heading" });
  heading.createEl("h1", { text: "Your conversations" });
  heading.createEl("p", { text: "Pick up where you left off." });
  const searchBox = column.createDiv({ cls: "obsidiai-history-search" });
  setIcon(searchBox.createSpan({ attr: { "aria-hidden": "true" } }), "search");
  this.search = searchBox.createEl("input", { type: "search", attr: { placeholder: "Search conversations…", "aria-label": "Search conversations", spellcheck: "false" } });
  this.registerDomEvent(this.search, "input", () => { this.limit = 50; this.confirming = undefined; this.renderResults(); });
  this.count = column.createDiv({ cls: "obsidiai-history-count", attr: { role: "status", "aria-live": "polite" } });
  this.selectionBar = column.createDiv({ cls: "obsidiai-history-selection", attr: { role: "group", "aria-label": "Selected conversations" } });
  this.selectionBar.hidden = true;
  this.error = column.createDiv({ cls: "obsidiai-error", attr: { role: "alert" } }); this.error.hidden = true;
  this.results = column.createDiv({ cls: "obsidiai-history-results" });
  const footer = column.createDiv({ cls: "obsidiai-history-footer" });
  footer.createEl("p", { text: "Opening a chat resets permissions to Ask. New messages use your currently selected provider and model." });
  const privacy = footer.createEl("details");
  privacy.createEl("summary", { text: "About saved chat data" });
  privacy.createEl("p", { text: "Chats can include sent note excerpts, skill instructions and tool results. They are saved unencrypted by this plugin in history.json inside the vault configuration folder. Sync and backups may copy this file. Deleting a chat removes only this plugin’s saved copy, not copies already synced or backed up." });
  this.registerDomEvent(this.container, "keydown", event => {
   if (event.isComposing) return;
   if (event.key === "Escape") {
    event.preventDefault(); event.stopPropagation();
    if (this.busy) return;
    if (this.pendingDeletion) this.cancelBulkDelete();
    else if (this.confirming) this.cancelDelete();
    else if (this.selecting) this.setSelecting(false);
    else this.returnToChat(false);
   } else if (event.key === "Enter" && event.target === this.search && !this.selecting && !this.loading && this.visibleConversations[0]) {
    event.preventDefault(); void this.openConversation(this.visibleConversations[0]);
   }
  });
  this.register(this.controller.subscribe(() => { if (this.visible) this.syncControls(); }));
 }
 show(): void {
  this.visible = true; this.container.hidden = false;
  this.container.scrollTop = 0;
  this.search.value = ""; this.limit = 50; this.confirming = undefined;
  this.selecting = false; this.selected.clear(); this.pendingDeletion = undefined;
  this.search.focus({ preventScroll: true });
  void this.refresh();
 }
 hide(): void { this.visible = false; this.generation++; this.pendingDeletion = undefined; this.container.hidden = true; }
 onunload(): void { this.hide(); this.container.empty(); }
 private setError(message: string): void { this.error.setText(message); this.error.hidden = !message; }
 private async refresh(): Promise<void> {
  const generation = ++this.generation;
  this.loading = true; this.setError(""); this.renderResults();
  try {
   const conversations = await this.controller.listHistory();
   if (!this.visible || generation !== this.generation) return;
   this.conversations = conversations;
   const ids = new Set(conversations.map(chat => chat.id));
   for (const id of this.selected) if (!ids.has(id)) this.selected.delete(id);
  } catch {
   if (!this.visible || generation !== this.generation) return;
   this.conversations = [];
   this.setError("Chat history could not be read. Check plugin-folder access and history.json. Unreadable history will not be silently replaced.");
  } finally {
   if (this.visible && generation === this.generation) { this.loading = false; this.renderResults(); }
  }
 }
 private renderResults(): void {
  this.results.empty(); this.visibleConversations = [];
  if (this.loading) { this.matches = []; this.renderSelection(); this.count.setText("Loading conversations…"); this.syncControls(); return; }
  if (!this.error.hidden && !this.conversations.length) {
   this.matches = []; this.renderSelection();
   this.count.setText("History unavailable");
   new ButtonComponent(this.results).setButtonText("Try again").onClick(() => { void this.refresh(); }).buttonEl.addClass("obsidiai-text-button");
   this.syncControls(); return;
  }
  const query = this.search.value.trim().toLocaleLowerCase();
  const matches = query ? this.conversations.filter(chat => chat.title.toLocaleLowerCase().includes(query) || chat.providerId.toLocaleLowerCase().includes(query) || chat.modelId.toLocaleLowerCase().includes(query)) : this.conversations;
  this.matches = matches; this.renderSelection();
  this.count.setText(query ? `${matches.length} result${matches.length === 1 ? "" : "s"}` : `${matches.length} saved conversation${matches.length === 1 ? "" : "s"}`);
  if (!matches.length) {
   const empty = this.results.createDiv({ cls: "obsidiai-history-empty" });
   setIcon(empty.createDiv({ cls: "obsidiai-history-empty-icon", attr: { "aria-hidden": "true" } }), query ? "search" : "messages-square");
   empty.createEl("h2", { text: query ? "No conversations found" : "A fresh start" });
   empty.createEl("p", { text: query ? "Try another title, provider, or model." : "Your conversations will appear here after a response finishes." });
   new ButtonComponent(empty).setButtonText(query ? "Clear search" : "Back to chat").onClick(() => {
    if (query) { this.search.value = ""; this.renderResults(); this.search.focus(); } else this.returnToChat(false);
   }).buttonEl.addClass("obsidiai-text-button");
   this.syncControls(); return;
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const week = new Date(today); week.setDate(today.getDate() - 7);
  let lastGroup = "";
  let group: HTMLElement | undefined;
  this.visibleConversations = matches.slice(0, this.limit);
  for (const chat of this.visibleConversations) {
   const label = chat.updatedAt >= +today ? "Today" : chat.updatedAt >= +yesterday ? "Yesterday" : chat.updatedAt >= +week ? "Previous 7 days" : "Earlier";
   if (label !== lastGroup) {
    const section = this.results.createEl("section", { cls: "obsidiai-history-group", attr: { "aria-label": label } });
    section.createEl("h2", { text: label }); group = section.createDiv({ cls: "obsidiai-history-rows" }); lastGroup = label;
   }
   this.renderRow(group!, chat);
  }
  if (matches.length > this.limit) new ButtonComponent(this.results).setButtonText(`Show more (${matches.length - this.limit} remaining)`).onClick(() => {
   const previous = this.limit; this.limit += 50; this.renderResults();
   this.results.querySelectorAll<HTMLElement>(this.selecting ? 'input[type="checkbox"]' : ".obsidiai-history-open")[previous]?.focus({ preventScroll: true });
  }).buttonEl.addClass("obsidiai-text-button", "obsidiai-history-more");
  this.syncControls();
 }
 private renderRow(group: HTMLElement, chat: ConversationSummary): void {
  const row = group.createDiv({ cls: "obsidiai-history-row" }); row.dataset.conversationId = chat.id;
  row.dataset.selected = String(this.selected.has(chat.id));
  if (this.confirming === chat.id) {
   row.addClass("obsidiai-history-confirming");
   const copy = row.createDiv({ cls: "obsidiai-history-confirm-copy" });
   copy.createEl("h3", { text: `Delete “${chat.title}”?` });
   copy.createEl("p", { text: "This permanently removes the plugin’s saved copy. Synced copies and backups are not removed." });
   const actions = row.createDiv({ cls: "obsidiai-history-confirm-actions" });
   const cancel = new ButtonComponent(actions).setButtonText("Keep chat").onClick(() => this.cancelDelete());
   cancel.buttonEl.addClass("obsidiai-text-button");
   new ButtonComponent(actions).setButtonText("Delete permanently").setWarning().onClick(() => { void this.deleteConversations([chat.id]); });
   cancel.buttonEl.focus({ preventScroll: true });
   return;
  }
  const open = row.createEl(this.selecting ? "label" : "button", { cls: "obsidiai-history-open", attr: this.selecting ? { title: chat.title } : { type: "button", "aria-label": `Open conversation: ${chat.title}`, title: chat.title } });
  if (this.selecting) {
   const checkbox = open.createEl("input", { type: "checkbox", attr: { "aria-label": `Select conversation: ${chat.title}` } });
   checkbox.checked = this.selected.has(chat.id);
   checkbox.addEventListener("change", () => {
    if (this.busy || this.pendingDeletion || !this.controller.idle) return;
    if (checkbox.checked) this.selected.add(chat.id); else this.selected.delete(chat.id);
    row.dataset.selected = String(checkbox.checked);
    this.renderSelection(); this.syncControls();
   });
  } else setIcon(open.createSpan({ cls: "obsidiai-history-row-icon", attr: { "aria-hidden": "true" } }), "message-square");
  const copy = open.createSpan({ cls: "obsidiai-history-copy" });
  copy.createSpan({ cls: "obsidiai-history-title", text: chat.title });
  const meta = copy.createSpan({ cls: "obsidiai-history-meta" });
  meta.createSpan({ cls: "obsidiai-history-model", text: `${chat.providerId} · ${chat.modelId}` });
  const date = new Date(chat.updatedAt);
  meta.createSpan({ cls: "obsidiai-history-date", text: date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }), attr: { title: date.toLocaleString() } });
  if (this.selecting) return;
  open.addEventListener("click", () => { void this.openConversation(chat); });
  const remove = new ButtonComponent(row).setIcon("trash-2").setTooltip(`Delete conversation: ${chat.title}`).onClick(() => {
   if (this.busy || !this.controller.idle) return;
   this.confirming = chat.id; this.renderResults();
  });
  remove.buttonEl.addClass("obsidiai-icon-button", "obsidiai-history-delete");
  remove.buttonEl.setAttrs({ "aria-label": `Delete conversation: ${chat.title}`, type: "button" });
 }
 private cancelDelete(): void {
  if (this.busy) return;
  const id = this.confirming; this.confirming = undefined; this.renderResults();
  for (const row of this.results.querySelectorAll<HTMLElement>(".obsidiai-history-row")) if (row.dataset.conversationId === id) row.querySelector<HTMLButtonElement>(".obsidiai-history-delete")?.focus({ preventScroll: true });
 }
 private setSelecting(value: boolean): void {
  if (this.busy || this.loading || this.pendingDeletion || !this.controller.idle) return;
  this.selecting = value; this.confirming = undefined; this.selected.clear();
  this.renderResults();
  if (value) this.results.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus({ preventScroll: true });
  else this.selectionToggle.buttonEl.focus({ preventScroll: true });
 }
 private renderSelection(): void {
  this.selectionToggle.setButtonText(this.selecting ? "Done" : "Select chats");
  this.selectionToggle.buttonEl.setAttr("aria-pressed", String(this.selecting));
  this.selectionBar.hidden = !this.selecting;
  this.selectionBar.empty();
  this.selectAllButton = undefined; this.clearSelectionButton = undefined; this.deleteSelectionButton = undefined;
  if (!this.selecting) return;
  let outside = this.selected.size;
  for (const chat of this.matches) if (this.selected.has(chat.id)) outside--;
  this.selectionBar.createDiv({ cls: "obsidiai-history-selected-count", text: `${this.selected.size} selected${outside ? ` · ${outside} outside this filter` : ""}`, attr: { role: "status", "aria-live": "polite" } });
  const ids = this.pendingDeletion;
  if (ids) {
   const confirmation = this.selectionBar.createDiv({ cls: "obsidiai-history-bulk-confirm" });
   confirmation.createEl("h3", { text: `Delete ${ids.length} conversation${ids.length === 1 ? "" : "s"}?` });
   confirmation.createEl("p", { text: "This permanently removes all selected chats from the plugin’s saved history, including selections outside this filter. Synced copies and backups are not removed." });
   const titles = confirmation.createEl("ul");
   let shown = 0;
   for (const chat of this.conversations) if (this.selected.has(chat.id) && shown++ < 5) titles.createEl("li", { text: chat.title });
   if (shown > 5) titles.createEl("li", { text: `And ${shown - 5} more selected conversations.` });
   const actions = confirmation.createDiv({ cls: "obsidiai-history-confirm-actions" });
   new ButtonComponent(actions).setButtonText("Keep chats").onClick(() => this.cancelBulkDelete()).buttonEl.addClass("obsidiai-text-button");
   new ButtonComponent(actions).setButtonText(`Delete ${ids.length} permanently`).setWarning().onClick(() => {
    if (this.pendingDeletion === ids) void this.deleteConversations(ids);
   });
   return;
  }
  const actions = this.selectionBar.createDiv({ cls: "obsidiai-history-selection-actions" });
  this.selectAllButton = new ButtonComponent(actions).setButtonText("Select all results").onClick(() => {
   for (const chat of this.matches) this.selected.add(chat.id);
   this.renderResults(); this.clearSelectionButton?.buttonEl.focus({ preventScroll: true });
  });
  this.selectAllButton.buttonEl.addClass("obsidiai-text-button");
  this.clearSelectionButton = new ButtonComponent(actions).setButtonText("Clear selection").onClick(() => {
   this.selected.clear(); this.renderResults(); this.selectAllButton?.buttonEl.focus({ preventScroll: true });
  });
  this.clearSelectionButton.buttonEl.addClass("obsidiai-text-button");
  this.deleteSelectionButton = new ButtonComponent(actions).setButtonText("Delete selected").setWarning().onClick(() => {
   if (this.busy || !this.controller.idle || !this.selected.size) return;
   this.pendingDeletion = [...this.selected]; this.renderSelection(); this.syncControls();
   this.selectionBar.querySelector<HTMLButtonElement>(".obsidiai-history-confirm-actions button")?.focus({ preventScroll: true });
  });
 }
 private cancelBulkDelete(): void {
  if (this.busy) return;
  this.pendingDeletion = undefined; this.renderSelection(); this.syncControls();
  this.deleteSelectionButton?.buttonEl.focus({ preventScroll: true });
 }
 private syncControls(): void {
  this.container.setAttr("aria-busy", String(this.busy || this.loading));
  const locked = this.busy || !this.controller.idle;
  this.back.setDisabled(this.busy); this.search.disabled = this.busy || !!this.pendingDeletion;
  this.selectionToggle.setDisabled(locked || this.loading || !!this.pendingDeletion || (!this.selecting && !this.conversations.length));
  for (const control of this.results.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")) control.disabled = locked || !!this.pendingDeletion;
  for (const button of this.selectionBar.querySelectorAll<HTMLButtonElement>("button")) button.disabled = locked;
  this.selectAllButton?.setDisabled(locked || !this.matches.length || this.matches.every(chat => this.selected.has(chat.id)));
  this.clearSelectionButton?.setDisabled(locked || !this.selected.size);
  this.deleteSelectionButton?.setDisabled(locked || !this.selected.size);
 }
 private async openConversation(chat: ConversationSummary): Promise<void> {
  await this.act(async () => { await this.controller.openConversation(chat.id); if (this.visible) this.returnToChat(true); }, "Could not open this conversation. Your current chat is retained. Check history.json and try again.");
 }
 private async deleteConversations(ids: readonly string[]): Promise<void> {
  await this.act(async () => {
   await this.controller.deleteConversations(ids);
   if (this.visible) {
    this.confirming = undefined; this.pendingDeletion = undefined; this.selected.clear(); this.selecting = false;
    await this.refresh(); this.search.focus({ preventScroll: true });
   }
  }, "Could not delete the selected conversations. Check plugin-folder access and try again.");
 }
 private async act(action: () => Promise<void>, failure: string): Promise<void> {
  if (!this.visible || this.busy || this.loading || !this.controller.idle) return;
  this.busy = true; this.setError(""); this.syncControls();
  try { await action(); }
  catch { if (this.visible) this.setError(failure); }
  finally { this.busy = false; if (this.visible) this.syncControls(); }
 }
}
