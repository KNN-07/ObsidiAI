import { ButtonComponent, Component, FuzzySuggestModal, ItemView, MarkdownRenderer, Notice, TFile, type App, type WorkspaceLeaf } from "obsidian";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { AgentController, TimelineItem } from "../agent/controller";
import { ConnectionSettingsModal, getConnectionBusy, subscribeConnectionState, type SettingsHost } from "../settings";
import { validateVaultPath } from "../vault/paths";

export const AGENT_VIEW_TYPE = "obsidiai-agent";
export interface AgentViewHost extends SettingsHost {
 controller: AgentController | null;
 disabledReason: string;
 skillChoices(): Promise<{ name: string; description: string; diagnostic?: boolean }[]>;
 viewClosed(closingLeaf: WorkspaceLeaf): void;
}
class ChoiceModal<T> extends FuzzySuggestModal<T> {
 constructor(app: App, private readonly choices: T[], private readonly label: (item: T) => string, private readonly choose: (item: T) => void) { super(app); }
 getItems(): T[] { return this.choices; }
 getItemText(item: T): string { return this.label(item); }
 onChooseItem(item: T): void { this.choose(item); }
}
export class AgentView extends ItemView {
 navigation = false;
 private unsubscribe?: () => void;
 private hostUnsubscribe?: () => void;
 private connectionUnsubscribe?: () => void;
 private frame?: number;
 private timelineEl?: HTMLElement;
 private chips?: HTMLElement;
 private textarea?: HTMLTextAreaElement;
 private statusEl?: HTMLElement;
 private modelButton?: ButtonComponent;
 private sendButton?: ButtonComponent;
 private stopButton?: ButtonComponent;
 private newButton?: ButtonComponent;
 private jump?: ButtonComponent;
 private rendered = new Map<string, { el: HTMLElement; text: Text; last: string; complete: boolean; component?: Component }>();
 constructor(leaf: WorkspaceLeaf, private readonly host: AgentViewHost) { super(leaf); }
 getViewType(): string { return AGENT_VIEW_TYPE; }
 getDisplayText(): string { return "ObsidiAI"; }
 getIcon(): string { return "bot"; }
 async onOpen(): Promise<void> {
  this.contentEl.empty(); this.contentEl.addClass("obsidiai-agent");
  if (!this.host.controller) { this.contentEl.createEl("h2", { text: "ObsidiAI" }); this.contentEl.createEl("p", { text: this.host.disabledReason || "Agent initialization is unavailable." }); new ButtonComponent(this.contentEl).setButtonText("Settings").onClick(() => new ConnectionSettingsModal(this.app, this.host).open()); return; }
  const controller = this.host.controller;
  const toolbar = this.contentEl.createDiv({ cls: "obsidiai-toolbar" });
  this.modelButton = new ButtonComponent(toolbar).setButtonText("Choose model").onClick(() => { void this.chooseModel(); });
  this.newButton = new ButtonComponent(toolbar).setButtonText("New conversation").onClick(() => { void controller.reset(); });
  new ButtonComponent(toolbar).setButtonText("Settings").onClick(() => new ConnectionSettingsModal(this.app, this.host).open());
  this.statusEl = this.contentEl.createDiv({ cls: "obsidiai-status", attr: { role: "status" } });
  this.contentEl.createEl("p", { cls: "obsidiai-disclosure", text: "On Send, this agent may inspect vault notes, metadata, graph structure, skill instructions, and non-secret plugin manifests and send returned context to your selected provider. Note edits and plugin changes each require approval. Installing or enabling community plugins can run third-party code with Obsidian privileges. Conversations stay in memory." });
  this.timelineEl = this.contentEl.createDiv({ cls: "obsidiai-timeline", attr: { "aria-label": "Conversation" } });
  this.jump = new ButtonComponent(this.contentEl).setButtonText("Jump to latest").onClick(() => { this.timelineEl!.scrollTop = this.timelineEl!.scrollHeight; this.jump!.buttonEl.hide(); }); this.jump.buttonEl.hide();
  this.chips = this.contentEl.createDiv({ cls: "obsidiai-chips" });
  this.textarea = this.contentEl.createEl("textarea", { cls: "obsidiai-composer", placeholder: "Ask about your vault…", attr: { "aria-label": "Message" } });
  this.registerDomEvent(this.textarea, "keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void this.send(); } });
  const actions = this.contentEl.createDiv({ cls: "obsidiai-actions" });
  new ButtonComponent(actions).setButtonText("Attach note").onClick(() => this.attachNote());
  new ButtonComponent(actions).setButtonText("Skills").onClick(() => { void this.chooseSkill(); });
  this.sendButton = new ButtonComponent(actions).setButtonText("Send").setCta().onClick(() => { void this.send(); });
  this.stopButton = new ButtonComponent(actions).setButtonText("Stop").onClick(() => { void controller.stop(); });
  this.unsubscribe = controller.subscribe(() => this.schedule()); this.hostUnsubscribe = this.host.subscribe(() => this.schedule()); this.render();
  this.connectionUnsubscribe = subscribeConnectionState(this.host, () => this.schedule());
 }
 async chooseSkill(): Promise<void> {
  try {
   const choices = await this.host.skillChoices();
   if (!choices.length) { new Notice(this.host.skillsStatus()); return; }
   new ChoiceModal(this.app, choices, s => `${s.diagnostic ? "Diagnostic: " : ""}${s.name} — ${s.description}`, s => { if (s.diagnostic) new Notice(`${s.name}: ${s.description}`); else this.host.controller?.selectSkill(s.name); }).open();
  } catch { new Notice("Could not read skills. Review skill-folder diagnostics in Settings."); }
 }
 private async chooseModel(): Promise<void> {
  if (!this.host.controller?.idle || !this.host.runtime) return;
  const provider = this.host.settings.providerId;
  if (!provider) { new ConnectionSettingsModal(this.app, this.host).open(); return; }
  try {
   const models = await this.host.runtime.models.getAvailable(provider);
   if (!models.length) { new Notice("No available models. Connect or refresh models in Settings."); return; }
   new ChoiceModal<Model<Api>>(this.app, [...models], m => `${m.name} (${m.id})`, m => {
    if (!this.host.controller?.idle) return;
    this.host.settings.modelId = m.id;
    void this.host.saveSettings().then(() => this.host.connectionChanged()).catch(() => new Notice("Could not save model selection."));
   }).open();
  } catch { new Notice("Connection check failed. Reconnect in Settings."); }
 }
 private attachNote(): void {
  const files = this.app.vault.getMarkdownFiles().filter(file => { try { validateVaultPath(file.path, this.app.vault.configDir); return true; } catch { return false; } });
  new ChoiceModal<TFile>(this.app, files, f => f.path, file => {
   void this.app.vault.read(file).then(content => this.host.controller?.addAttachment(file.path, content)).catch(error => new Notice(error instanceof Error ? error.message : "Could not attach note."));
  }).open();
 }
 private async send(): Promise<void> {
  const controller = this.host.controller;
  if (!controller || !this.textarea) return;
  if (getConnectionBusy(this.host)) { new Notice("Wait for the connection operation to finish."); return; }
  const draft = this.textarea.value;
  try { await controller.send(draft, () => { if (this.textarea?.value === draft) this.textarea.value = ""; }); }
  catch (error) { new Notice(error instanceof Error && error.name !== "AbortError" ? error.message : "Stopped before submission."); }
 }
 private schedule(): void { if (this.frame === undefined) this.frame = this.contentEl.win.requestAnimationFrame(() => { this.frame = undefined; this.render(); }); }
 private render(): void {
  const controller = this.host.controller;
  if (!controller || !this.timelineEl) return;
  const nearBottom = this.timelineEl.scrollHeight - this.timelineEl.scrollTop - this.timelineEl.clientHeight < 80;
  this.statusEl!.setText(controller.setupMessage || `Agent: ${controller.state}`);
  this.modelButton!.setButtonText(`${this.host.settings.providerId ?? "Provider"} / ${this.host.settings.modelId ?? "Choose model"}`).setDisabled(!controller.idle);
  this.newButton!.setDisabled(!controller.idle); this.sendButton!.setDisabled(!controller.idle || !controller.ready || getConnectionBusy(this.host)); this.stopButton!.setDisabled(controller.idle);
  this.chips!.empty();
  for (const attachment of controller.attachments) new ButtonComponent(this.chips!).setButtonText(`${attachment.path} ×`).setTooltip("Remove attachment snapshot").onClick(() => controller.removeAttachment(attachment.id));
  for (const name of controller.selectedSkills) new ButtonComponent(this.chips!).setButtonText(`Skill: ${name} ×`).setTooltip("Remove selected skill").onClick(() => controller.removeSkill(name));
  const ids = new Set(controller.timeline.map(item => item.id));
  for (const [id, rendered] of this.rendered) if (!ids.has(id)) { if (rendered.component) this.removeChild(rendered.component); rendered.el.remove(); this.rendered.delete(id); }
  for (const item of controller.timeline) this.renderItem(item);
  if (nearBottom) { this.timelineEl.scrollTop = this.timelineEl.scrollHeight; this.jump!.buttonEl.hide(); } else this.jump!.buttonEl.show();
 }
 private renderItem(item: TimelineItem): void {
  let rendered = this.rendered.get(item.id);
  if (!rendered) {
   const el = this.timelineEl!.createDiv({ cls: `obsidiai-message obsidiai-${item.kind}` });
   const text = el.doc.createTextNode(""); el.appendChild(text);
   rendered = { el, text, last: "", complete: false }; this.rendered.set(item.id, rendered);
  }
  if (item.kind === "tool") {
   rendered.el.setAttr("data-status", item.complete ? item.status ?? "success" : this.host.controller?.state === "awaiting-approval" ? "awaiting approval" : this.host.controller?.state === "stopping" ? "stopping" : "running");
   if (item.toolName === "propose_plugin_change") rendered.el.addClass("obsidiai-code-warning");
  }
  if (rendered.complete) return;
  if (item.text.startsWith(rendered.last)) rendered.text.appendData(item.text.slice(rendered.last.length)); else rendered.text.data = item.text;
  rendered.last = item.text;
  if (!item.complete) return;
  rendered.complete = true;
  if (item.status && item.kind !== "tool") rendered.el.createDiv({ cls: "obsidiai-outcome", text: item.status });
  if (item.kind === "assistant") {
   rendered.el.empty(); const component = new Component(); this.addChild(component); rendered.component = component;
   void MarkdownRenderer.render(this.app, item.text, rendered.el, item.sourcePath, component).catch(() => rendered!.el.setText(item.text));
  }
  if (item.kind === "tool") {
   if (item.toolName === "propose_plugin_change") rendered.el.addClass("obsidiai-code-warning");
   const paths = new Set<string>();
   const inspect = (value: unknown, depth: number): void => {
    if (depth > 6 || paths.size >= 200) return;
    if (typeof value === "string" && value.endsWith(".md")) { try { paths.add(validateVaultPath(value, this.app.vault.configDir)); } catch { /* Not a vault target. */ } }
    else if (Array.isArray(value)) for (const child of value) inspect(child, depth + 1);
    else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) if (["path", "paths", "nodes", "source", "destination", "from", "to", "results", "items", "notes", "edges"].includes(key)) inspect(child, depth + 1);
   };
   inspect(item.details, 0);
   for (const path of paths) { const link = rendered.el.createEl("a", { text: path, cls: "internal-link", href: path }); this.registerDomEvent(link, "click", event => { event.preventDefault(); void this.app.workspace.openLinkText(path, item.sourcePath); }); }
  }
 }
 private release(): void {
  this.unsubscribe?.(); this.hostUnsubscribe?.(); this.connectionUnsubscribe?.();
  if (this.frame !== undefined) this.contentEl.win.cancelAnimationFrame(this.frame);
  this.frame = undefined;
  for (const item of this.rendered.values()) if (item.component) this.removeChild(item.component);
  this.rendered.clear();
 }
 async onClose(): Promise<void> { this.release(); this.host.viewClosed(this.leaf); }
 onunload(): void { this.release(); }
}
