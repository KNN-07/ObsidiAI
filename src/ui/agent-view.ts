import { ButtonComponent, Component, FuzzySuggestModal, ItemView, MarkdownRenderer, Notice, TFile, setIcon } from "obsidian";
import type { App, WorkspaceLeaf } from "obsidian";
import type { Model, Api, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentController, TimelineItem } from "../agent/controller";
import { ConnectionSettingsModal, getConnectionBusy, runConnectionOperation, subscribeConnectionState } from "../settings";
import type { SettingsHost } from "../settings";
import { validateVaultPath } from "../vault/paths";
import type { PermissionMode } from "./approval";
import { renderApprovalCard } from "./approval-card";
import { ComposerSuggest, type ComposerChoice, type ComposerTrigger } from "./composer-suggest";
import { ChatHistoryView } from "./history-view";
import type { Attachment } from "../agent/attachments";
import { FILE_ACCEPT, isLargePaste, readAttachmentFile } from "./attachment-input";
import { AttachmentPreviewModal } from "./attachment-preview";

export const AGENT_VIEW_TYPE = "obsidiai-agent";
export interface AgentViewHost extends SettingsHost {
 controller: AgentController | null;
 disabledReason: string;
 skillChoices(): Promise<{ name: string; description: string; diagnostic?: boolean; userInvocable?: boolean }[]>;
 viewClosed(closingLeaf: WorkspaceLeaf): void;
 openNotePaths(): string[];
 captureOpenNotes(excludedPaths: readonly string[]): Promise<{ path: string; content: string }[]>;
}
class ChoiceModal<T> extends FuzzySuggestModal<T> {
 constructor(app: App, private readonly choices: T[], private readonly label: (item: T) => string, private readonly choose: (item: T) => void) { super(app); }
 getItems(): T[] { return this.choices; }
 getItemText(item: T): string { return this.label(item); }
 onChooseItem(item: T): void { this.choose(item); }
}
const THINKING_LABELS: Record<ModelThinkingLevel, string> = {
 off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum",
};
const PERMISSION_LABELS: Record<PermissionMode, string> = {
 "read-only": "Read-only", ask: "Ask before changes", "auto-approve-notes": "Auto-approve notes",
};
const PERMISSION_DESCRIPTIONS: Record<PermissionMode, string> = {
 "read-only": "Inspect context without changing notes or plugins.",
 ask: "Review each note or plugin change before it runs.",
 "auto-approve-notes": "Note edits and creation run without approval. Plugin changes still require approval.",
};
interface RenderedMessage {
 el: HTMLElement;
 body: HTMLElement;
 text: Text;
 last: string;
 complete: boolean;
 component?: Component;
 status?: HTMLElement;
 context?: HTMLElement;
 notice?: HTMLElement;
 tail?: HTMLElement;
 tailText?: string;
}
interface RenderedToolChain {
 el: HTMLDetailsElement;
 body: HTMLElement;
 label: HTMLElement;
 status: HTMLElement;
}
const TOOL_PRESENTATION: Record<string, { label: string; icon: string }> = {
 list_files: { label: "Exploring folders", icon: "folder-tree" },
 search_notes: { label: "Searching notes", icon: "search" },
 read_note: { label: "Reading a note", icon: "file-text" },
 propose_note_edit: { label: "Note edit", icon: "file-pen-line" },
 propose_note_create: { label: "New note", icon: "file-plus-2" },
 get_vault_info: { label: "Vault overview", icon: "vault" },
 get_note_metadata: { label: "Note metadata", icon: "tags" },
 query_notes: { label: "Finding notes", icon: "list-filter" },
 query_graph: { label: "Exploring connections", icon: "network" },
 list_skills: { label: "Available skills", icon: "sparkles" },
 load_skill: { label: "Loading a skill", icon: "sparkles" },
 read_skill_resource: { label: "Skill reference", icon: "book-open" },
 list_plugins: { label: "Installed plugins", icon: "blocks" },
 search_community_plugins: { label: "Finding plugins", icon: "blocks" },
 get_plugin_details: { label: "Plugin details", icon: "blocks" },
 propose_plugin_change: { label: "Plugin change", icon: "shield-alert" },
 inspect_plugin_settings: { label: "Reviewing plugin settings access", icon: "eye" },
 propose_plugin_settings_change: { label: "Plugin settings change", icon: "settings-2" },
};
const STATUS_LABELS: Record<string, string> = {
 running: "Working", "awaiting-approval": "Needs approval", stopping: "Stopping",
 success: "Done", applied: "Applied", shared: "Shared", unchanged: "Unchanged", rejected: "Rejected",
 cancelled: "Cancelled", aborted: "Stopped", error: "Error", failed: "Failed", conflict: "Conflict",
};

export class AgentView extends ItemView {
 navigation = false;
 private unsubscribe?: () => void;
 private hostUnsubscribe?: () => void;
 private connectionUnsubscribe?: () => void;
 private frame?: number;
 private resizeObserver?: ResizeObserver;
 private closed = false;
 private followLatest = true;
 private scrollViewportWidth = 0;
 private scrollViewportHeight = 0;
 private scrollEl?: HTMLElement;
 private timelineEl?: HTMLElement;
 private emptyEl?: HTMLElement;
 private setupEl?: HTMLElement;
 private setupText?: HTMLElement;
 private chips?: HTMLElement;
 private textarea?: HTMLTextAreaElement;
 private statusEl?: HTMLElement;
 private modelButton?: ButtonComponent;
 private modelLabel?: HTMLElement;
 private thinkingButton?: ButtonComponent;
 private thinkingLabel?: HTMLElement;
 private permissionButton?: ButtonComponent;
 private permissionLabel?: HTMLElement;
 private openNotesButton?: ButtonComponent;
 private readonly excludedOpenNotes = new Set<string>();
 private disclosure?: HTMLElement;
 private modelProbe?: AbortController;
 private selectionModal?: FuzzySuggestModal<Model<Api>> | FuzzySuggestModal<ModelThinkingLevel> | FuzzySuggestModal<PermissionMode>;
 private sendButton?: ButtonComponent;
 private stopButton?: ButtonComponent;
 private newButton?: ButtonComponent;
 private jump?: ButtonComponent;
 private historyButton?: ButtonComponent;
 private historyView?: ChatHistoryView;
 private chatStage?: HTMLElement;
 private composerSuggest?: ComposerSuggest;
 private contextModal?: { close(): void };
 private attachmentEpoch = 0;
 private attachmentPending = false;
 private attachmentStatus?: HTMLElement;
 private fileInput?: HTMLInputElement;
 private fileButton?: ButtonComponent;
 private filePickerEpoch?: number;
 private pastedTextCount = 0;
 private dropHint?: HTMLElement;
 private dragDepth = 0;
 private readonly rendered = new Map<string, RenderedMessage>();
 private readonly draftChips = new Map<string, HTMLElement>();
 private readonly toolChains = new Map<string, RenderedToolChain>();
 private approvalEl?: HTMLElement;
 private approvalId?: string;
 constructor(leaf: WorkspaceLeaf, private readonly host: AgentViewHost) { super(leaf); }
 getViewType(): string { return AGENT_VIEW_TYPE; }
 getDisplayText(): string { return "ObsidiAI"; }
 getIcon(): string { return "obsidiai-logo"; }

 private iconButton(container: HTMLElement, label: string, icon: string, action: () => void): ButtonComponent {
  const button = new ButtonComponent(container).setIcon(icon).setTooltip(label).onClick(action);
  button.buttonEl.addClass("obsidiai-icon-button");
  button.buttonEl.setAttrs({ "aria-label": label, type: "button" });
  return button;
 }

 async onOpen(): Promise<void> {
  this.closed = false;
  this.followLatest = true;
  this.contentEl.empty();
  this.contentEl.addClass("obsidiai-agent");
  const header = this.contentEl.createDiv({ cls: "obsidiai-header" });
  const brand = header.createDiv({ cls: "obsidiai-brand" });
  setIcon(brand.createSpan({ cls: "obsidiai-brand-mark", attr: { "aria-hidden": "true" } }), "obsidiai-logo");
  brand.createSpan({ text: "ObsidiAI" });
  this.statusEl = header.createSpan({ cls: "obsidiai-status", attr: { role: "status", "aria-live": "polite" } });
  const headerActions = header.createDiv({ cls: "obsidiai-header-actions" });
  const controller = this.host.controller;
  if (controller) {
   this.newButton = this.iconButton(headerActions, "New conversation", "square-pen", () => {
    this.attachmentEpoch++; this.composerSuggest?.dismiss();
    void controller.reset().then(() => {
     if (!this.textarea || this.closed) return;
     this.excludedOpenNotes.clear();
     this.closeHistory(true);
     this.textarea.value = ""; this.attachmentStatus?.empty(); this.resizeComposer(); this.textarea.focus(); this.schedule();
    }).catch(error => { if (!this.closed) new Notice(error instanceof Error ? error.message : "Could not start a new conversation. Your current chat is retained."); });
   });
   this.historyButton = this.iconButton(headerActions, "Conversation history", "history", () => {
    if (!controller.idle || this.attachmentPending) return;
    if (this.historyView?.isVisible) { this.closeHistory(); return; }
    this.attachmentEpoch++; this.composerSuggest?.dismiss(); this.contextModal?.close();
    this.chatStage!.hidden = true;
    this.historyButton!.buttonEl.setAttr("aria-pressed", "true");
    this.historyView?.show();
   });
   this.historyButton.buttonEl.setAttr("aria-pressed", "false");
  }
  this.iconButton(headerActions, "Settings", "settings-2", () => new ConnectionSettingsModal(this.app, this.host).open());
  if (!controller) {
   const unavailable = this.contentEl.createDiv({ cls: "obsidiai-unavailable" });
   setIcon(unavailable.createDiv({ cls: "obsidiai-hero-mark", attr: { "aria-hidden": "true" } }), "obsidiai-logo");
   unavailable.createEl("h2", { text: "A little setup first." });
   unavailable.createEl("p", { text: this.host.disabledReason || "Agent initialization is unavailable." });
   new ButtonComponent(unavailable).setButtonText("Open settings").onClick(() => new ConnectionSettingsModal(this.app, this.host).open());
   return;
  }

  const stage = this.contentEl.createDiv({ cls: "obsidiai-stage" });
  this.chatStage = stage;
  this.historyView = new ChatHistoryView(this.contentEl.createDiv(), controller, opened => this.closeHistory(opened));
  this.addChild(this.historyView);
  this.scrollEl = stage.createDiv({ cls: "obsidiai-scroll" });
  this.emptyEl = this.scrollEl.createDiv({ cls: "obsidiai-welcome" });
  setIcon(this.emptyEl.createDiv({ cls: "obsidiai-hero-mark", attr: { "aria-hidden": "true" } }), "obsidiai-logo");
  this.emptyEl.createEl("h1", { text: "What’s on your mind?" });
  this.emptyEl.createEl("p", { cls: "obsidiai-welcome-copy", text: "A place to think with your notes." });
  const suggestions = this.emptyEl.createDiv({ cls: "obsidiai-suggestions" });
  for (const suggestion of [
   { label: "Find a note", detail: "Start with a topic", icon: "search", prompt: "Find notes related to " },
   { label: "Connect ideas", detail: "Follow the links", icon: "network", prompt: "Help me explore connections between notes. Ask which topic I want to start with." },
   { label: "Review a draft", detail: "Make it clearer", icon: "file-pen-line", prompt: "Help me review a note and suggest improvements. Ask which note to work on before proposing any edits." },
  ]) {
   const button = suggestions.createEl("button", { cls: "obsidiai-suggestion", attr: { type: "button" } });
   setIcon(button.createSpan({ cls: "obsidiai-suggestion-icon", attr: { "aria-hidden": "true" } }), suggestion.icon);
   const copy = button.createSpan({ cls: "obsidiai-suggestion-copy" });
   copy.createSpan({ cls: "obsidiai-suggestion-title", text: suggestion.label });
   copy.createSpan({ cls: "obsidiai-suggestion-detail", text: suggestion.detail });
   this.registerDomEvent(button, "click", () => {
    if (!this.textarea || !controller.idle) return;
    this.textarea.value = suggestion.prompt; this.resizeComposer(); this.textarea.focus(); this.schedule();
   });
  }
  this.timelineEl = this.scrollEl.createDiv({ cls: "obsidiai-timeline", attr: { "aria-label": "Conversation" } });
  this.registerDomEvent(this.timelineEl, "click", event => this.openModifiedNoteLink(event), { capture: true });
  this.registerDomEvent(this.scrollEl, "scroll", () => {
   // Pane/composer resizing is not a request to stop following the response.
   if (this.scrollEl!.clientWidth !== this.scrollViewportWidth || this.scrollEl!.clientHeight !== this.scrollViewportHeight) { this.schedule(); return; }
   this.followLatest = this.scrollEl!.scrollHeight - this.scrollEl!.scrollTop - this.scrollEl!.clientHeight < 80;
   this.jump!.buttonEl.hidden = this.followLatest;
  });

  const composeRegion = stage.createDiv({ cls: "obsidiai-compose-region" });
  this.jump = new ButtonComponent(composeRegion).setButtonText("Jump to latest").onClick(() => this.scrollToLatest());
  this.jump.buttonEl.addClass("obsidiai-jump"); this.jump.buttonEl.hidden = true;
  this.setupEl = composeRegion.createDiv({ cls: "obsidiai-setup", attr: { role: "status" } });
  this.setupText = this.setupEl.createSpan();
  const connect = new ButtonComponent(this.setupEl).setButtonText("Set up").onClick(() => new ConnectionSettingsModal(this.app, this.host).open());
  connect.buttonEl.addClass("obsidiai-text-button");

  const composer = composeRegion.createDiv({ cls: "obsidiai-composer-card" });
  this.chips = composer.createDiv({ cls: "obsidiai-chips", attr: { "aria-label": "Draft context" } });
  this.textarea = composer.createEl("textarea", { cls: "obsidiai-composer", attr: { placeholder: "Ask anything about your vault…", "aria-label": "Message", rows: "2" } });
  this.registerDomEvent(this.textarea, "input", () => { this.resizeComposer(); this.schedule(); });
  this.registerDomEvent(this.textarea, "paste", event => this.pasteAttachments(event));
  this.composerSuggest = new ComposerSuggest(this.textarea, composer, trigger => this.contextChoices(trigger),
   choice => { if (choice.kind !== "skill") void this.attachTarget(choice); },
   () => { void this.send(); }, () => !this.closed && controller.idle && !this.attachmentPending,
   () => { this.resizeComposer(); this.schedule(); });
  this.attachmentStatus = composer.createDiv({ cls: "obsidiai-attachment-status", attr: { role: "status", "aria-live": "polite" } });
  const actions = composer.createDiv({ cls: "obsidiai-composer-actions" });
  const contextActions = actions.createDiv({ cls: "obsidiai-context-actions" });
  this.iconButton(contextActions, "Attach note", "paperclip", () => this.attachNote());
  this.fileInput = composer.createEl("input", { type: "file", attr: { accept: FILE_ACCEPT, multiple: "", "aria-label": "Choose text files or images" } });
  this.fileInput.hidden = true;
  this.fileButton = this.iconButton(contextActions, "Attach files from computer", "file-up", () => {
   if (!this.canAttach()) return;
   this.filePickerEpoch = this.attachmentEpoch; this.fileInput!.click();
  });
  this.registerDomEvent(this.fileInput, "change", () => {
   const files = Array.from(this.fileInput!.files ?? []); this.fileInput!.value = "";
   if (this.filePickerEpoch === this.attachmentEpoch) void this.attachFiles(files);
  });
  const skills = new ButtonComponent(contextActions).onClick(() => { void this.chooseSkill(); });
  skills.buttonEl.addClass("obsidiai-text-button");
  setIcon(skills.buttonEl.createSpan({ attr: { "aria-hidden": "true" } }), "sparkles");
  skills.buttonEl.createSpan({ text: "Skills" });
  this.openNotesButton = new ButtonComponent(contextActions).onClick(() => { void this.toggleOpenNotes(); });
  this.openNotesButton.buttonEl.addClass("obsidiai-text-button", "obsidiai-open-notes-button");
  setIcon(this.openNotesButton.buttonEl.createSpan({ attr: { "aria-hidden": "true" } }), "panels-top-left");
  this.openNotesButton.buttonEl.createSpan({ text: "Open notes" });
  const modelActions = actions.createDiv({ cls: "obsidiai-model-actions" });
  this.modelButton = new ButtonComponent(modelActions).onClick(() => { void this.chooseModel(); });
  this.modelButton.buttonEl.addClass("obsidiai-model-button");
  this.modelLabel = this.modelButton.buttonEl.createSpan();
  setIcon(this.modelButton.buttonEl.createSpan({ attr: { "aria-hidden": "true" } }), "chevron-down");
  this.thinkingButton = new ButtonComponent(modelActions).onClick(() => this.chooseThinking());
  this.thinkingButton.buttonEl.addClass("obsidiai-thinking-button");
  setIcon(this.thinkingButton.buttonEl.createSpan({ attr: { "aria-hidden": "true" } }), "brain");
  this.thinkingLabel = this.thinkingButton.buttonEl.createSpan();
  this.permissionButton = new ButtonComponent(modelActions).onClick(() => this.choosePermissions());
  this.permissionButton.buttonEl.addClass("obsidiai-text-button", "obsidiai-permission-button");
  setIcon(this.permissionButton.buttonEl.createSpan({ attr: { "aria-hidden": "true" } }), "shield-check");
  this.permissionLabel = this.permissionButton.buttonEl.createSpan();
  this.sendButton = this.iconButton(modelActions, "Send message", "arrow-up", () => { void this.send(); });
  this.sendButton.buttonEl.addClass("obsidiai-send");
  this.stopButton = this.iconButton(modelActions, "Stop generation", "square", () => { void controller.stop(); });
  this.stopButton.buttonEl.addClass("obsidiai-stop");
  this.disclosure = composeRegion.createEl("p", { cls: "obsidiai-disclosure" });
  composeRegion.createDiv({ cls: "obsidiai-composer-hint", text: "Drop text files or images · Paste images or long text · @ notes · / skills · Enter to send" });
  this.dropHint = stage.createDiv({ cls: "obsidiai-drop-hint", text: "Drop text files or images to attach", attr: { role: "status" } }); this.dropHint.hidden = true;
  this.registerDomEvent(this.contentEl, "dragenter", event => {
   if (!event.dataTransfer?.types.includes("Files")) return;
   event.preventDefault(); event.stopPropagation(); this.dragDepth++;
   if (this.canAttach()) this.dropHint!.hidden = false;
  });
  this.registerDomEvent(this.contentEl, "dragover", event => {
   if (!event.dataTransfer?.types.includes("Files")) return;
   event.preventDefault(); event.stopPropagation();
   event.dataTransfer.dropEffect = this.canAttach() ? "copy" : "none";
  });
  this.registerDomEvent(this.contentEl, "dragleave", event => {
   if (!event.dataTransfer?.types.includes("Files")) return;
   event.stopPropagation(); this.dragDepth = Math.max(0, this.dragDepth - 1);
   if (!this.dragDepth) this.dropHint!.hidden = true;
  });
  this.registerDomEvent(this.contentEl, "drop", event => {
   if (!event.dataTransfer?.types.includes("Files")) return;
   event.preventDefault(); event.stopPropagation(); this.dragDepth = 0; this.dropHint!.hidden = true;
   const files: File[] = [];
   for (const item of Array.from(event.dataTransfer.items)) {
    if (item.kind !== "file") continue;
    if (item.webkitGetAsEntry?.()?.isDirectory) { new Notice("Drop individual files, not folders."); continue; }
    const file = item.getAsFile(); if (file) files.push(file);
   }
   if (!event.dataTransfer.items.length) files.push(...Array.from(event.dataTransfer.files));
   void this.attachFiles(files);
  });

  this.unsubscribe = controller.subscribe(() => this.schedule());
  this.hostUnsubscribe = this.host.subscribe(() => this.schedule());
  this.connectionUnsubscribe = subscribeConnectionState(this.host, () => this.schedule());
  let width = 0;
  this.resizeObserver = new ResizeObserver(entries => {
   for (const entry of entries) if (entry.target === composer && entry.contentRect.width !== width) {
    width = entry.contentRect.width; this.resizeComposer();
   }
   this.schedule();
  });
  this.resizeObserver.observe(composer);
  this.resizeObserver.observe(this.scrollEl);
  this.render();
 }

 private closeHistory(opened = false): void {
  if (this.closed || !this.historyView?.isVisible) return;
  this.historyView.hide(); this.chatStage!.hidden = false;
  this.historyButton!.buttonEl.setAttr("aria-pressed", "false");
  if (opened) { this.excludedOpenNotes.clear(); this.followLatest = true; this.textarea?.focus(); }
  else this.historyButton!.buttonEl.focus();
  this.schedule();
 }
 async chooseSkill(): Promise<void> {
  try {
   const epoch = this.attachmentEpoch;
   const choices = (await this.host.skillChoices()).filter(s => s.userInvocable !== false);
   if (this.closed || epoch !== this.attachmentEpoch || !this.host.controller?.idle) return;
   if (!choices.length) { new Notice(this.host.skillsStatus()); return; }
   const picker = new ChoiceModal(this.app, choices, s => `${s.diagnostic ? "Diagnostic: " : ""}${s.name} — ${s.description}`, s => {
    if (this.closed || epoch !== this.attachmentEpoch || !this.host.controller?.idle) return;
    if (s.diagnostic) new Notice(`${s.name}: ${s.description}`); else this.host.controller.selectSkill(s.name);
   });
   this.contextModal = picker; picker.open();
  } catch { new Notice("Could not read skills. Review skill-folder diagnostics in Settings."); }
 }
 private async chooseModel(): Promise<void> {
  if (!this.host.controller?.idle || !this.host.runtime || this.modelProbe || getConnectionBusy(this.host)) return;
  const probe = new AbortController(); this.modelProbe = probe; this.schedule();
  const registry = this.host.runtime.models;
  try {
   const results = await Promise.all(registry.getProviders().map(async provider => {
    try { return { models: await registry.getAvailable(provider.id, { signal: probe.signal }), error: "" }; }
    catch { return { models: [], error: provider.name }; }
   }));
   if (this.closed || probe.signal.aborted || !this.host.controller?.idle || getConnectionBusy(this.host)) return;
   const failed = results.filter(result => result.error).map(result => result.error);
   if (failed.length) new Notice(`Could not check ${failed.join(", ")}. Other available providers are still listed; review authentication in Settings.`);
   const models = results.flatMap(result => result.models).sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
   if (!models.length) {
    new Notice("No available models. Add provider authentication or refresh models in Settings.");
    new ConnectionSettingsModal(this.app, this.host).open(); return;
   }
   const picker = new ChoiceModal<Model<Api>>(this.app, models, m => `${registry.getProvider(m.provider)?.name ?? m.provider} · ${m.name} (${m.id})`, m => {
    if (this.closed || !this.host.controller?.idle || getConnectionBusy(this.host)) return;
    const selection = new AbortController(); this.modelProbe = selection;
    void runConnectionOperation(this.host, async () => {
     const available = await registry.getAvailable(m.provider, { signal: selection.signal });
     if (this.closed || selection.signal.aborted) return;
     if (!available.some(model => model.id === m.id)) throw new Error("Model is no longer available. Reconnect or refresh models in Settings.");
     const previousProvider = this.host.settings.providerId, previousModel = this.host.settings.modelId;
     this.host.settings.providerId = m.provider; this.host.settings.modelId = m.id;
     try { await this.host.saveSettings(); }
     catch (error) { this.host.settings.providerId = previousProvider; this.host.settings.modelId = previousModel; throw error; }
     await this.host.connectionChanged();
    }).catch(() => { if (!this.closed && !selection.signal.aborted) new Notice("Could not select this model. Review authentication and storage in Settings."); })
     .finally(() => { if (this.modelProbe === selection) this.modelProbe = undefined; this.schedule(); });
   });
   picker.setPlaceholder("Search available providers and models…");
   this.selectionModal = picker; picker.open();
  } catch { if (!this.closed && !probe.signal.aborted) new Notice("Could not load available models. Review authentication in Settings."); }
  finally { if (this.modelProbe === probe) this.modelProbe = undefined; this.schedule(); }
 }
 private chooseThinking(): void {
  const controller = this.host.controller;
  if (!controller?.idle || !controller.ready || getConnectionBusy(this.host) || controller.thinkingLevels.length < 2) return;
  const providerId = this.host.settings.providerId, modelId = this.host.settings.modelId;
  const picker = new ChoiceModal<ModelThinkingLevel>(this.app, [...controller.thinkingLevels], level => `${THINKING_LABELS[level]}${level === controller.thinkingLevel ? " — selected" : ""}`, level => {
   if (this.closed || !controller.idle || !controller.ready || providerId !== this.host.settings.providerId || modelId !== this.host.settings.modelId) return;
   void runConnectionOperation(this.host, async () => {
    const previous = this.host.settings.thinkingLevel, previousEffective = controller.thinkingLevel;
    controller.setThinkingLevel(level); this.host.settings.thinkingLevel = level;
    try { await this.host.saveSettings(); }
    catch (error) {
     this.host.settings.thinkingLevel = previous;
     if (controller.idle && controller.ready) controller.setThinkingLevel(previousEffective);
     throw error;
    }
   }).catch(() => { if (!this.closed) new Notice("Could not save thinking effort. The previous setting is retained."); });
  });
  picker.setPlaceholder("Thinking effort · higher levels may use more tokens and time");
  this.selectionModal = picker; picker.open();
 }
 private choosePermissions(): void {
  const controller = this.host.controller;
  if (!controller?.idle || getConnectionBusy(this.host)) return;
  const modes: PermissionMode[] = ["read-only", "ask", "auto-approve-notes"];
  const picker = new ChoiceModal<PermissionMode>(this.app, modes, mode => `${PERMISSION_LABELS[mode]}${mode === controller.permissionMode ? " — selected" : ""} · ${PERMISSION_DESCRIPTIONS[mode]}`, mode => {
   if (this.closed || !controller.idle || getConnectionBusy(this.host)) return;
   controller.setPermissionMode(mode);
  });
  picker.setPlaceholder("Permissions · resets to Ask before changes for each new conversation");
  this.selectionModal = picker; picker.open();
 }
 private async toggleOpenNotes(): Promise<void> {
  if (this.closed || !this.host.controller?.idle || this.attachmentPending || getConnectionBusy(this.host)) return;
  try {
   await runConnectionOperation(this.host, async () => {
    const previous = this.host.settings.autoAttachOpenNotes;
    this.host.settings.autoAttachOpenNotes = !previous;
    try { await this.host.saveSettings(); }
    catch (error) { this.host.settings.autoAttachOpenNotes = previous; throw error; }
    this.excludedOpenNotes.clear();
   });
  } catch { if (!this.closed) new Notice("Could not save open-note context. The previous setting is retained."); }
 }
 private permittedNotes(): TFile[] {
  return this.app.vault.getMarkdownFiles().filter(file => { try { validateVaultPath(file.path, this.app.vault.configDir); return true; } catch { return false; } });
 }
 private async contextChoices(trigger: ComposerTrigger): Promise<ComposerChoice[]> {
  const query = trigger.query.toLocaleLowerCase();
  if (trigger.kind === "skill") return (await this.host.skillChoices())
   .filter(s => !s.diagnostic && s.userInvocable !== false && s.name.toLocaleLowerCase().includes(query))
   .map(s => ({ kind: "skill", value: s.name, detail: s.description }));
  const files = this.permittedNotes(), folders = new Map<string, number>();
  for (const file of files) {
   const parts = file.path.split("/"); parts.pop();
   while (parts.length) { const path = parts.join("/"); folders.set(path, (folders.get(path) ?? 0) + 1); parts.pop(); }
  }
  const choices: ComposerChoice[] = files.map(file => ({ kind: "file", value: file.path, detail: "Attach note snapshot" }));
  for (const [path, count] of folders) choices.push({ kind: "folder", value: path, detail: `Attach ${count} Markdown note${count === 1 ? "" : "s"} in this folder and subfolders` });
  return choices.filter(choice => choice.value.toLocaleLowerCase().includes(query)).sort((a, b) => a.value.localeCompare(b.value));
 }
 private canAttach(): boolean {
  return !this.closed && !!this.host.controller?.idle && !this.attachmentPending && !this.historyView?.isVisible;
 }
 private pasteAttachments(event: ClipboardEvent): void {
  if (!event.clipboardData) return;
  const files = Array.from(event.clipboardData.files);
  const text = event.clipboardData.getData("text/plain");
  if (files.length) { event.preventDefault(); event.stopPropagation(); void this.attachFiles(files); return; }
  if (!isLargePaste(text)) return;
  event.preventDefault(); event.stopPropagation();
  if (!this.canAttach()) { new Notice("Wait for the current operation before attaching pasted text."); return; }
  try {
   const path = `Pasted text ${++this.pastedTextCount}.txt`;
   this.host.controller!.addAttachment({ kind: "text", path, content: text });
   this.textarea!.setRangeText("", this.textarea!.selectionStart, this.textarea!.selectionEnd, "end");
   this.composerSuggest?.dismiss(); this.resizeComposer(); this.schedule();
   this.attachmentStatus?.setText(`${path} attached. Click its chip to preview. Nothing is sent until Send.`);
  } catch (error) { new Notice(error instanceof Error ? error.message : "Could not attach pasted text."); }
 }
 private async attachFiles(files: readonly File[]): Promise<void> {
  if (!files.length) return;
  if (!this.canAttach()) { new Notice("Return to chat and wait for the current operation before attaching files."); return; }
  const controller = this.host.controller!;
  const epoch = this.attachmentEpoch;
  this.attachmentPending = true; this.composerSuggest?.dismiss(); this.schedule();
  let attached = 0;
  const failures: string[] = [];
  this.attachmentStatus?.setText(`Reading ${files.length} file${files.length === 1 ? "" : "s"}…`);
  try {
   for (const file of files) {
    try {
     const attachment = await readAttachmentFile(file);
     if (this.closed || epoch !== this.attachmentEpoch || !controller.idle) return;
     controller.addAttachment(attachment); attached++;
    } catch (error) {
     if (this.closed || epoch !== this.attachmentEpoch) return;
     failures.push(`${file.name.split(/[\\/]/).pop() || "File"}: ${error instanceof Error ? error.message : "Could not read file."}`);
    }
   }
   if (!this.closed && epoch === this.attachmentEpoch) {
    this.attachmentStatus?.setText(`${attached} attached. Click a chip to preview.${failures.length ? ` ${failures.join(" ")}` : " Nothing is sent until Send."}`);
    if (failures.length) new Notice(failures.join("\n"), 10000);
   }
  } finally { this.attachmentPending = false; this.schedule(); }
 }
 private previewAttachment(attachment: Attachment): void {
  if (this.closed) return;
  this.contextModal?.close();
  const preview = new AttachmentPreviewModal(this.app, attachment);
  this.contextModal = preview; preview.open();
 }
 private openModifiedNoteLink(event: MouseEvent): void {
  if (event.button !== 0 || (!event.ctrlKey && !event.metaKey)) return;
  const target = event.target as HTMLElement | null;
  const link = target?.closest?.<HTMLElement>("a.internal-link, .internal-embed");
  if (!link || !this.timelineEl?.contains(link)) return;
  const path = link.getAttribute("data-href") ?? link.getAttribute("href") ?? link.getAttribute("src") ?? link.getAttribute("data-src");
  if (!path || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path)) return;
  const source = link.closest<HTMLElement>(".obsidiai-message")?.dataset.sourcePath ?? "";
  event.preventDefault(); event.stopImmediatePropagation();
  void this.app.workspace.openLinkText(path, source, "tab").catch(() => new Notice("Could not open the note in a new tab."));
 }
 private attachNote(): void {
  if (this.closed || !this.host.controller?.idle || this.attachmentPending) return;
  const epoch = this.attachmentEpoch;
  const picker = new ChoiceModal<TFile>(this.app, this.permittedNotes(), f => f.path, file => {
   if (!this.closed && epoch === this.attachmentEpoch) void this.attachTarget({ kind: "file", value: file.path, detail: "" });
  });
  this.contextModal = picker; picker.open();
 }
 private async attachTarget(choice: ComposerChoice): Promise<void> {
  const controller = this.host.controller;
  if (this.closed || !controller?.idle || this.attachmentPending) return;
  const epoch = this.attachmentEpoch;
  const files = this.permittedNotes().filter(file => choice.kind === "folder" ? file.path.startsWith(`${choice.value}/`) : file.path === choice.value);
  this.attachmentPending = true; this.schedule();
  const failures: string[] = [];
  let attached = 0, duplicate = 0;
  this.attachmentStatus?.setText(`Attaching ${choice.value}${choice.kind === "folder" ? "/" : ""} · ${files.length} notes…`);
  try {
   for (const file of files) {
    if (this.closed || epoch !== this.attachmentEpoch || !controller.idle) return;
    if (controller.attachments.some(a => a.kind === "note" && a.path === file.path)) { duplicate++; continue; }
    const path = file.path;
    try {
     const content = await this.app.vault.read(file);
     if (this.closed || epoch !== this.attachmentEpoch || !controller.idle) return;
     if (file.path !== path || this.app.vault.getFileByPath(path) !== file) throw new Error("Note moved or removed");
     validateVaultPath(path, this.app.vault.configDir);
     if (controller.attachments.some(a => a.kind === "note" && a.path === path)) { duplicate++; continue; }
     controller.addAttachment({ kind: "note", path, content }); attached++;
    } catch { failures.push(path); }
   }
   if (!this.closed && epoch === this.attachmentEpoch) {
    const summary = `${choice.value}${choice.kind === "folder" ? "/" : ""}: ${attached} attached${duplicate ? `, ${duplicate} already attached` : ""}${!files.length ? "; no eligible notes remain" : ""}${failures.length ? `. Could not attach ${failures.length} (unreadable, changed, or attachment limits exceeded): ${failures.join(", ")}` : ""}`;
    this.attachmentStatus?.setText(summary);
    if (failures.length || !files.length) new Notice(summary, 10000);
   }
  } finally { this.attachmentPending = false; this.schedule(); }
 }
 private async send(): Promise<void> {
  const controller = this.host.controller;
  if (!controller || !this.textarea || !controller.idle || this.attachmentPending || (!this.textarea.value.trim() && !controller.selectedSkills.size && !controller.attachments.length)) return;
  if (getConnectionBusy(this.host)) { new Notice("Wait for the connection operation to finish."); return; }
  if (!controller.ready) { new Notice(controller.setupMessage); return; }
  const draft = this.textarea.value;
  const epoch = ++this.attachmentEpoch;
  const autoAttach = this.host.settings.autoAttachOpenNotes;
  const automaticIds: string[] = [];
  this.composerSuggest?.dismiss(); this.contextModal?.close();
  this.attachmentPending = true; this.schedule();
  try {
   if (autoAttach) {
    const snapshots = await this.host.captureOpenNotes([...this.excludedOpenNotes, ...controller.attachments.filter(a => a.kind === "note").map(a => a.path)]);
    if (this.closed || epoch !== this.attachmentEpoch || !controller.idle || !this.host.settings.autoAttachOpenNotes) return;
    for (const snapshot of snapshots) {
     controller.addAttachment({ kind: "note", path: snapshot.path, content: snapshot.content });
     automaticIds.push(controller.attachments.at(-1)!.id);
    }
   }
   await controller.send(draft, () => {
    this.excludedOpenNotes.clear();
    if (this.textarea?.value === draft && !this.closed) { this.textarea.value = ""; this.attachmentStatus?.empty(); this.resizeComposer(); }
    this.followLatest = true;
   });
  } catch (error) { if (!this.closed) new Notice(error instanceof Error && error.name !== "AbortError" ? error.message : "Stopped before submission."); }
  finally {
   // Failed preparation must not turn automatic snapshots into stale manual attachments.
   for (const id of automaticIds) if (controller.attachments.some(a => a.id === id)) controller.removeAttachment(id);
   this.attachmentPending = false; this.schedule();
  }
 }
 private resizeComposer(): void {
  if (!this.textarea || this.closed) return;
  this.textarea.style.height = "auto";
  this.textarea.style.height = `${Math.min(this.textarea.scrollHeight, 220)}px`;
 }
 private scrollToLatest(): void {
  if (!this.scrollEl || this.closed) return;
  this.followLatest = true;
  this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
  if (this.jump) this.jump.buttonEl.hidden = true;
 }
 private schedule(): void {
  if (!this.closed && this.frame === undefined) this.frame = this.contentEl.win.requestAnimationFrame(() => { this.frame = undefined; this.render(); });
 }
 private render(): void {
  const controller = this.host.controller;
  if (!controller || !this.timelineEl || this.closed) return;
  const empty = controller.timeline.length === 0;
  if (empty) this.followLatest = true;
  this.contentEl.setAttr("data-empty", String(empty));
  this.emptyEl!.hidden = !empty;
  this.timelineEl.hidden = empty;
  const busy = getConnectionBusy(this.host);
  this.statusEl!.setText(controller.idle ? busy ? "Connecting" : controller.ready ? "Ready" : "Not connected" : STATUS_LABELS[controller.state] ?? controller.state);
  this.statusEl!.setAttr("data-state", controller.state);
  this.setupEl!.hidden = !controller.setupMessage;
  this.setupText!.setText(controller.setupMessage);
  const { providerId, modelId } = this.host.settings;
  const model = providerId && modelId ? this.host.runtime?.models.getModel(providerId, modelId) : undefined;
  this.modelLabel!.setText(model?.name ?? "Choose model");
  const providerName = providerId ? this.host.runtime?.models.getProvider(providerId)?.name ?? providerId : "";
  this.modelButton!.setTooltip(providerId && modelId ? `${providerName} / ${modelId}` : "Choose a model from your connected providers").setDisabled(!controller.idle || busy || !!this.modelProbe);
  this.modelButton!.buttonEl.setAttr("aria-label", `Choose model: ${providerName ? `${providerName} / ` : ""}${model?.name ?? "not selected"}`);
  const thinking = THINKING_LABELS[controller.thinkingLevel];
  this.thinkingLabel!.setText(thinking);
  this.thinkingButton!.setDisabled(!controller.idle || !controller.ready || busy || controller.thinkingLevels.length < 2)
   .setTooltip(controller.ready && controller.thinkingLevels.length < 2 ? `This model has fixed thinking effort: ${thinking}` : `Thinking effort: ${thinking}. Higher levels may use more tokens and time.`);
  this.thinkingButton!.buttonEl.setAttr("aria-label", `Thinking effort: ${thinking}`);
  const permission = PERMISSION_LABELS[controller.permissionMode];
  this.permissionLabel!.setText(permission);
  this.permissionButton!.setDisabled(!controller.idle || busy).setTooltip(`${PERMISSION_DESCRIPTIONS[controller.permissionMode]} New conversations reset to Ask before changes.`);
  this.permissionButton!.buttonEl.setAttr("aria-label", `Permissions: ${permission}`);
  this.openNotesButton!.setDisabled(!controller.idle || this.attachmentPending || busy)
   .setTooltip(this.host.settings.autoAttachOpenNotes ? "Open-note context is on. Visible Markdown tabs are captured at Send, including unsaved edits. Remove a chip to exclude a note for this message." : "Automatically attach open Markdown notes at Send. Their contents go to your provider and saved chat history.");
  this.openNotesButton!.buttonEl.setAttrs({ "aria-pressed": String(this.host.settings.autoAttachOpenNotes), "aria-label": "Automatically attach open notes" });
  this.permissionButton!.buttonEl.setAttr("data-mode", controller.permissionMode);
  this.disclosure!.setText(`The agent may send notes, metadata, graph links, skills, and non-secret plugin manifests to your provider. Attached text/images and explicitly shared plugin settings are sent to your provider and saved in chat history. ${PERMISSION_DESCRIPTIONS[controller.permissionMode]} Plugin changes can run third-party code. ${controller.historyMessage}`);
  this.newButton!.setDisabled(!controller.idle || this.attachmentPending);
  this.historyButton!.setDisabled(!controller.idle || this.attachmentPending);
  this.sendButton!.setDisabled(!controller.idle || !controller.ready || busy || this.attachmentPending || (!this.textarea!.value.trim() && !controller.selectedSkills.size && !controller.attachments.length));
  this.fileButton!.setDisabled(!this.canAttach());
  if (!controller.idle) this.composerSuggest?.dismiss();
  this.sendButton!.buttonEl.hidden = !controller.idle;
  this.stopButton!.buttonEl.hidden = controller.idle;
  this.stopButton!.setDisabled(controller.state === "stopping");

  const chipKeys = new Set<string>();
  for (const attachment of controller.attachments) {
   const key = `attachment:${attachment.id}`; chipKeys.add(key);
   if (!this.draftChips.has(key)) {
    const chip = this.chips!.createDiv({ cls: "obsidiai-draft-attachment" });
    const preview = chip.createEl("button", { cls: "obsidiai-chip", attr: { type: "button", "aria-label": `Preview attachment: ${attachment.path}`, title: `Preview ${attachment.kind === "image" ? "image" : "text"}: ${attachment.path}` } });
    setIcon(preview.createSpan({ attr: { "aria-hidden": "true" } }), attachment.kind === "image" ? "image" : "file-text");
    preview.createSpan({ cls: "obsidiai-chip-label", text: attachment.path });
    preview.addEventListener("click", () => this.previewAttachment(attachment));
    const remove = chip.createEl("button", { cls: "obsidiai-chip obsidiai-attachment-remove", attr: { type: "button", "aria-label": `Remove attachment: ${attachment.path}`, title: "Remove attachment" } });
    setIcon(remove, "x"); remove.addEventListener("click", () => controller.removeAttachment(attachment.id));
    this.draftChips.set(key, chip);
   }
  }
  if (this.host.settings.autoAttachOpenNotes && controller.idle && !this.attachmentPending) {
   const manualPaths = new Set(controller.attachments.filter(a => a.kind === "note").map(a => a.path));
   for (const path of this.host.openNotePaths()) {
    if (manualPaths.has(path) || this.excludedOpenNotes.has(path)) continue;
    const key = `open:${path}`; chipKeys.add(key);
    if (!this.draftChips.has(key)) {
     this.addDraftChip(key, path, "panels-top-left", () => { this.excludedOpenNotes.add(path); this.schedule(); });
     this.draftChips.get(key)!.addClass("obsidiai-auto-context");
     this.draftChips.get(key)!.setAttrs({ title: `Open note · captured at Send: ${path}`, "aria-label": `Exclude open note from this message: ${path}` });
    }
   }
  }
  for (const name of controller.selectedSkills) {
   const key = `skill:${name}`; chipKeys.add(key);
   if (!this.draftChips.has(key)) this.addDraftChip(key, name, "sparkles", () => controller.removeSkill(name));
  }
  for (const [key, button] of this.draftChips) {
   if (!chipKeys.has(key)) { button.remove(); this.draftChips.delete(key); }
   else {
    if (button.tagName === "BUTTON") (button as HTMLButtonElement).disabled = !controller.idle || this.attachmentPending;
    for (const child of button.querySelectorAll<HTMLButtonElement>("button")) child.disabled = !controller.idle || this.attachmentPending;
   }
  }
  this.chips!.hidden = chipKeys.size === 0;
  const ids = new Set(controller.timeline.map(item => item.id));
  for (const [id, rendered] of this.rendered) if (!ids.has(id)) { if (rendered.component) this.removeChild(rendered.component); rendered.el.remove(); this.rendered.delete(id); }
  this.renderTimeline(controller.timeline);
  this.renderApproval();
  this.scrollViewportWidth = this.scrollEl!.clientWidth;
  this.scrollViewportHeight = this.scrollEl!.clientHeight;
  if (this.followLatest) this.scrollToLatest();
 }

 private addDraftChip(key: string, label: string, icon: string, remove: () => void): void {
  const button = this.chips!.createEl("button", { cls: "obsidiai-chip", attr: { type: "button", "aria-label": `Remove ${label}`, title: label } });
  setIcon(button.createSpan({ attr: { "aria-hidden": "true" } }), icon);
  button.createSpan({ cls: "obsidiai-chip-label", text: label });
  setIcon(button.createSpan({ cls: "obsidiai-chip-remove", attr: { "aria-hidden": "true" } }), "x");
  button.addEventListener("click", remove);
  this.draftChips.set(key, button);
 }

 private renderTimeline(items: TimelineItem[]): void {
  const chains = new Set<string>();
  let chain: RenderedToolChain | undefined;
  let count = 0, working = false, failed = false;
  const update = () => {
   if (!chain) return;
   chain.label.setText(`${count} tool call${count === 1 ? "" : "s"}`);
   const status = working ? STATUS_LABELS[this.host.controller!.state] ?? "Working" : failed ? "Needs attention" : "Finished";
   chain.status.setText(status);
   chain.el.setAttr("data-state", working ? this.host.controller!.state : failed ? "error" : "complete");
  };
  for (const item of items) {
   if (item.kind === "tool") {
    if (!chain) {
     chains.add(item.id);
     chain = this.toolChains.get(item.id);
     if (!chain) {
      const el = this.timelineEl!.createEl("details", { cls: "obsidiai-tool-chain" });
      const summary = el.createEl("summary", { cls: "obsidiai-chain-summary" });
      setIcon(summary.createSpan({ cls: "obsidiai-chain-chevron", attr: { "aria-hidden": "true" } }), "chevron-right");
      const label = summary.createSpan({ cls: "obsidiai-chain-label" });
      const status = summary.createSpan({ cls: "obsidiai-chain-status" });
      chain = { el, label, status, body: el.createDiv({ cls: "obsidiai-chain-body" }) };
      this.toolChains.set(item.id, chain);
     }
     count = 0; working = false; failed = false;
    }
    count++; working ||= !item.complete;
    failed ||= ["error", "failed", "conflict"].includes(item.status ?? "");
    this.renderItem(item, chain.body);
   } else {
    // Tool-only assistant messages carry no visible narrative and do not split a chain.
    if (item.kind !== "assistant" || item.text) { update(); chain = undefined; }
    this.renderItem(item, this.timelineEl!);
   }
  }
  update();
  for (const [id, group] of this.toolChains) if (!chains.has(id)) { group.el.remove(); this.toolChains.delete(id); }
 }
 private renderApproval(): void {
  const approvals = this.host.controller!.services.approvals;
  const pending = approvals.current;
  if (pending?.id === this.approvalId) return;
  this.approvalEl?.remove(); this.approvalEl = undefined;
  this.approvalId = pending?.id;
  if (!pending) return;
  // Outside collapsible tool details: a collapsed chain must never hide the decision.
  this.approvalEl = this.timelineEl!.createDiv({ cls: "obsidiai-inline-approval", attr: { role: "region", "aria-label": "Pending tool approval" } });
  renderApprovalCard(this.approvalEl, pending, decision => {
   if (!this.closed) approvals.decide(pending.id, decision);
  });
 }
 private renderItem(item: TimelineItem, parent: HTMLElement): void {
  let rendered = this.rendered.get(item.id);
  if (!rendered) {
   const el = parent.createEl(item.kind === "tool" ? "details" : "div", { cls: `obsidiai-message obsidiai-${item.kind}` });
   el.dataset.sourcePath = item.sourcePath;
   let status: HTMLElement | undefined;
   let context: HTMLElement | undefined;
   let notice: HTMLElement | undefined;
   if (item.kind === "tool") {
    const presentation = TOOL_PRESENTATION[item.toolName ?? ""];
    const summary = el.createEl("summary", { cls: "obsidiai-tool-summary" });
    setIcon(summary.createSpan({ cls: "obsidiai-tool-icon", attr: { "aria-hidden": "true" } }), presentation?.icon ?? "wrench");
    const title = summary.createSpan({ cls: "obsidiai-tool-heading" });
    title.createSpan({ cls: "obsidiai-tool-title", text: presentation?.label ?? item.toolName ?? "Tool" });
    context = title.createSpan({ cls: "obsidiai-tool-context" });
    status = summary.createSpan({ cls: "obsidiai-tool-status" });
    setIcon(summary.createSpan({ cls: "obsidiai-tool-chevron", attr: { "aria-hidden": "true" } }), "chevron-right");
    if (item.toolName === "propose_plugin_change" || item.toolName === "propose_plugin_settings_change") {
     el.addClass("obsidiai-code-warning");
     title.createSpan({ cls: "obsidiai-code-notice", text: "Can run third-party code" });
    }
    notice = title.createSpan({ cls: "obsidiai-tool-notice" }); notice.hidden = true;
   } else if (item.kind === "assistant") {
    const author = el.createDiv({ cls: "obsidiai-author" });
    setIcon(author.createSpan({ cls: "obsidiai-assistant-logo", attr: { "aria-hidden": "true" } }), "obsidiai-logo");
    author.createSpan({ text: "ObsidiAI" });
   }
   const sentAttachments = item.kind === "user" ? this.host.controller!.getSentAttachments(item) : [];
   if (item.kind === "user" && (sentAttachments.length || item.attachmentPaths?.length || item.skillNames?.length)) {
    const attachments = el.createDiv({ cls: "obsidiai-sent-context", attr: { "aria-label": "Attached context" } });
    for (const attachment of sentAttachments) {
     const preview = attachments.createEl("button", { cls: "obsidiai-sent-attachment", attr: { type: "button", "aria-label": `Preview attachment: ${attachment.path}`, title: attachment.path } });
     setIcon(preview.createSpan({ attr: { "aria-hidden": "true" } }), attachment.kind === "image" ? "image" : "file-text");
     preview.createSpan({ text: attachment.path });
     preview.addEventListener("click", () => this.previewAttachment(attachment));
    }
    for (const path of sentAttachments.length ? [] : item.attachmentPaths ?? []) {
     try { validateVaultPath(path, this.app.vault.configDir); } catch { continue; }
     const link = attachments.createEl("a", { cls: "internal-link obsidiai-sent-attachment", href: path, attr: { "aria-label": `Open attached note: ${path}`, title: path } });
     setIcon(link.createSpan({ attr: { "aria-hidden": "true" } }), "file-text");
     link.createSpan({ text: path });
     link.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); void this.app.workspace.openLinkText(path, ""); });
    }
    for (const name of item.skillNames ?? []) {
     const skill = attachments.createSpan({ cls: "obsidiai-sent-attachment" });
     setIcon(skill.createSpan({ attr: { "aria-hidden": "true" } }), "sparkles");
     skill.createSpan({ text: name });
    }
   }
   const body = el.createDiv({ cls: item.kind === "tool" ? "obsidiai-tool-body" : "obsidiai-message-body" });
   const text = el.doc.createTextNode(""); body.appendChild(text);
   rendered = { el, body, text, last: "", complete: false, status, context, notice };
   this.rendered.set(item.id, rendered);
  }
  if (rendered.el.parentElement !== parent) parent.appendChild(rendered.el);
  if (item.kind === "tool") {
   const status = item.complete ? item.status ?? "success" : this.host.controller?.state === "awaiting-approval" ? "awaiting-approval" : this.host.controller?.state === "stopping" ? "stopping" : "running";
   rendered.el.setAttr("data-status", status);
   rendered.status!.setText(STATUS_LABELS[status] ?? status.replaceAll("_", " "));
   if (!rendered.complete && rendered.last !== item.text) {
    let data: unknown = item.details;
    if (!data) { try { data = JSON.parse(item.text.slice(item.text.indexOf("\n") + 1)); } catch { /* Tool text need not be JSON. */ } }
    if (data && typeof data === "object") {
     const detail = data as Record<string, unknown>;
     const context = [detail.action, detail.path ?? detail.pluginId ?? detail.name].filter(value => typeof value === "string");
     rendered.context!.setText(context.join(" · "));
     const notices = [detail.cacheStatus === "partial" ? "Provisional native-cache snapshot" : "", detail.truncated === true ? "Results truncated; more are available" : ""].filter(Boolean);
     rendered.notice!.setText(notices.join(" · ")); rendered.notice!.hidden = notices.length === 0;
    }
   }
  }
  if (rendered.complete) return;
  if (rendered.last !== item.text) {
   const append = item.text.startsWith(rendered.last);
   if (rendered.tail) {
    if (append) rendered.text.appendData(rendered.tailText ?? "");
    rendered.tail.remove(); rendered.tail = undefined; rendered.tailText = undefined;
   }
   if (item.kind === "assistant" && !item.complete && append) {
    const delta = item.text.slice(rendered.last.length);
    rendered.tail = rendered.body.createSpan({ cls: "obsidiai-stream-reveal", text: delta });
    rendered.tailText = delta;
   } else if (append) rendered.text.appendData(item.text.slice(rendered.last.length));
   else rendered.text.data = item.text;
  }
  rendered.last = item.text;
  rendered.el.setAttr("data-streaming", String(!item.complete));
  if (!item.complete) rendered.el.setAttr("data-live-response", "true");
  if (!item.complete) return;
  rendered.complete = true;
  if (item.kind === "assistant") {
   rendered.el.hidden = !item.text;
   rendered.tail = undefined; rendered.tailText = undefined;
   rendered.body.empty(); rendered.body.addClass("obsidiai-prose");
   const component = new Component(); this.addChild(component); rendered.component = component;
   const record = rendered;
   void MarkdownRenderer.render(this.app, item.text, rendered.body, item.sourcePath, component).then(() => {
    if (this.closed || this.rendered.get(item.id) !== record) return;
    // Fade the final Markdown only for a live response, never replay saved history.
    if (record.last && record.el.dataset.liveResponse === "true" && !item.status) record.body.addClass("obsidiai-result-reveal");
    if (this.rendered.get(item.id) === record && this.followLatest) this.scrollToLatest();
   }).catch(() => { if (!this.closed && this.rendered.get(item.id) === record) record.body.setText(item.text); });
  }
  if (item.kind === "tool") {
   if (["error", "failed", "conflict"].includes(item.status ?? "")) (rendered.el as HTMLDetailsElement).open = true;
   const paths = new Set<string>();
   const inspect = (value: unknown, depth: number): void => {
    if (depth > 6 || paths.size >= 200) return;
    if (typeof value === "string" && value.endsWith(".md")) { try { paths.add(validateVaultPath(value, this.app.vault.configDir)); } catch { /* Not a vault target. */ } }
    else if (Array.isArray(value)) for (const child of value) inspect(child, depth + 1);
    else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) if (["path", "paths", "nodes", "source", "destination", "from", "to", "results", "items", "notes", "edges"].includes(key)) inspect(child, depth + 1);
   };
   inspect(item.details, 0);
   if (paths.size) {
    const links = rendered.el.createDiv({ cls: "obsidiai-tool-links" });
    for (const path of paths) {
     const link = links.createEl("a", { text: path, cls: "internal-link", href: path });
     link.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); void this.app.workspace.openLinkText(path, item.sourcePath); });
    }
   }
  }
 }
 private release(): void {
  this.closed = true;
  this.attachmentEpoch++; this.composerSuggest?.dispose(); this.contextModal?.close();
  this.dragDepth = 0; this.filePickerEpoch = undefined; this.fileInput = undefined; this.fileButton = undefined; this.dropHint = undefined;
  if (this.historyView) { this.removeChild(this.historyView); this.historyView = undefined; }
  this.modelProbe?.abort(); this.selectionModal?.close();
  this.unsubscribe?.(); this.hostUnsubscribe?.(); this.connectionUnsubscribe?.();
  this.resizeObserver?.disconnect();
  if (this.frame !== undefined) this.contentEl.win.cancelAnimationFrame(this.frame);
  this.frame = undefined;
  for (const item of this.rendered.values()) if (item.component) this.removeChild(item.component);
  this.rendered.clear(); this.draftChips.clear(); this.toolChains.clear();
  this.approvalEl?.remove(); this.approvalEl = undefined; this.approvalId = undefined;
  this.excludedOpenNotes.clear();
 }
 async onClose(): Promise<void> { this.release(); this.host.viewClosed(this.leaf); }
 onunload(): void { this.release(); }
}
