import { addIcon, Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import { AgentView, AGENT_VIEW_TYPE, type AgentViewHost } from "./ui/agent-view";
import { AuthModal } from "./ui/auth-modal";
import { loadSettings, ObsidiAISettingTab, ConnectionSettingsModal, disposeProviderSettings, type ObsidiAISettings } from "./settings";
import { ObsidianCredentialStore } from "./agent/credentials";
import type { ProviderRuntime } from "./agent/runtime";
import type { AgentController } from "./agent/controller";
import type { SkillCatalog } from "./skills/catalog";
import type { MetadataService } from "./agent/metadata-tools";
import type { PluginLifecycleService } from "./agent/plugin-tools";
import type { ApprovalController } from "./ui/approval-modal";
import { HistoryStore } from "./agent/history";
import logoSvg from "../assets/obsidiai-logo.svg";

export function supportedNode(version: string): boolean {
 const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
 return major > 22 || (major === 22 && (minor > 19 || (minor === 19 && patch >= 0)));
}
export default class ObsidiAIPlugin extends Plugin implements AgentViewHost {
 declare settings: ObsidiAISettings;
 runtime: ProviderRuntime | null = null;
 credentials: ObsidianCredentialStore | null = null;
 controller: AgentController | null = null;
 disabledReason = "";
 private catalog?: SkillCatalog;
 private metadata?: MetadataService;
 private lifecycle?: PluginLifecycleService;
 private approvals?: ApprovalController;
 private saveQueue: Promise<void> = Promise.resolve();
 private opening?: Promise<WorkspaceLeaf>;
 private disposed = false;
 private readonly listeners = new Set<() => void>();
 async onload(): Promise<void> {
  const logo = new DOMParser().parseFromString(logoSvg, "image/svg+xml").documentElement;
  logo.querySelectorAll("title, desc").forEach(element => element.remove());
  addIcon("obsidiai-logo", `<g transform="scale(0.78125)">${logo.innerHTML}</g>`);
  this.settings = loadSettings(await this.loadData());
  await this.saveSettings();
  const version = typeof process !== "undefined" ? process.versions?.node ?? "0" : "0";
  if (!supportedNode(version)) {
   this.disabledReason = `ObsidiAI needs embedded Node 22.19.0 or newer (found ${version}). Update the Obsidian desktop installer; updating only the app may not update its embedded runtime.`;
   new Notice(this.disabledReason);
  } else {
   try {
    const [{ createProviderRuntime }, { AgentController }, { VaultToolService }, { ApprovalController }, { MetadataService }, { SkillCatalog }, { SkillToolService }, { PluginLifecycleService }] = await Promise.all([
     import("./agent/runtime"), import("./agent/controller"), import("./agent/vault-tools"), import("./ui/approval-modal"), import("./agent/metadata-tools"), import("./skills/catalog"), import("./agent/skill-tools"), import("./agent/plugin-tools")
    ]);
    if (this.disposed) return;
    this.credentials = new ObsidianCredentialStore(this.app, this.settings.credentialSecretId);
    this.runtime = createProviderRuntime(this.credentials);
    this.approvals = new ApprovalController(this.app);
    const notes = new VaultToolService(this.app, this.approvals);
    this.metadata = new MetadataService(this.app, this);
    this.catalog = new SkillCatalog(this.app, () => this.settings.skillsFolder, this);
    const skills = new SkillToolService(this.catalog);
    this.lifecycle = new PluginLifecycleService(this.app, this.manifest.id, this.approvals);
    const history = new HistoryStore(this.app.vault.adapter, `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/history.json`);
    this.controller = new AgentController(this.runtime, { notes, metadata: this.metadata, skills, plugins: this.lifecycle, approvals: this.approvals }, history);
    try { await history.list(); }
    catch { this.controller.historyMessage = "Chat history could not be read. Check plugin-folder access and history.json. Chat remains available, but saving may fail."; new Notice(this.controller.historyMessage); }
    this.register(this.controller.subscribe(() => { for (const listener of this.listeners) listener(); }));
    await this.connectionChanged();
   } catch { this.disabledReason = "ObsidiAI could not initialize its desktop runtime. Review connection settings and restart the plugin."; new Notice(this.disabledReason); }
  }
  this.registerView(AGENT_VIEW_TYPE, leaf => new AgentView(leaf, this));
  this.addCommand({ id: "open-agent", name: "Open agent tab", callback: () => { void this.openAgent(); } });
  this.addRibbonIcon("obsidiai-logo", "Open ObsidiAI agent", () => { void this.openAgent(); });
  this.addSettingTab(new ObsidiAISettingTab(this.app, this, this));
  this.addCommand({ id: "choose-skill", name: "Choose skill", callback: () => { void this.openAgent().then(leaf => { if (leaf.view instanceof AgentView) void leaf.view.chooseSkill(); }); } });
  this.addCommand({ id: "ask-about-selection", name: "Ask agent about selection", editorCheckCallback: (checking, editor, view) => {
   const content = editor.getSelection(); const path = view.file?.path;
   if (!content || !path || !this.controller) return false;
   if (!checking) { try { this.controller.addAttachment(path, content); void this.openAgent(); } catch (error) { new Notice(error instanceof Error ? error.message : "Could not attach selection."); } }
   return true;
  } });
 }
 saveSettings(): Promise<void> {
  const snapshot = { providerId: this.settings.providerId, modelId: this.settings.modelId, thinkingLevel: this.settings.thinkingLevel, credentialSecretId: this.settings.credentialSecretId, skillsFolder: this.settings.skillsFolder };
  const next = this.saveQueue.then(() => this.saveData(snapshot)); this.saveQueue = next.catch(() => undefined); return next;
 }
 isRunning(): boolean { return this.controller !== null && !this.controller.idle; }
 subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
 async connectionChanged(): Promise<void> { await this.controller?.configure(this.settings.providerId, this.settings.modelId, this.settings.thinkingLevel); for (const listener of this.listeners) listener(); }
 skillsStatus(): string { return this.catalog ? this.catalog.diagnostics.map(d => typeof d === "string" ? d : JSON.stringify(d)).join("\n") || `${this.catalog.entries.length} skills found in ${this.settings.skillsFolder}.` : "Skills are unavailable until the desktop runtime starts."; }
 async refreshSkills(): Promise<void> { await this.catalog?.refresh(true); for (const listener of this.listeners) listener(); }
 async skillChoices(): Promise<{ name: string; description: string; diagnostic?: boolean; userInvocable?: boolean }[]> {
  await this.catalog?.refresh();
  return this.catalog ? [
   ...this.catalog.entries.map(s => ({ name: s.name, description: `${s.manualOnly ? "(manual only) " : ""}${s.description}`, userInvocable: s.userInvocable })),
   ...this.catalog.diagnostics.map(d => ({ name: d.path, description: d.message, diagnostic: true }))
  ] : [];
 }
 pluginManagerStatus(): string { return this.lifecycle?.compatibilityStatus().message ?? "Plugin management is unavailable until the desktop runtime starts."; }
 openAgent(): Promise<WorkspaceLeaf> {
  if (this.opening) return this.opening;
  this.opening = (async () => {
   let found: WorkspaceLeaf | undefined;
   this.app.workspace.iterateRootLeaves(leaf => { if (!found && leaf.view.getViewType() === AGENT_VIEW_TYPE) found = leaf; });
   const leaf = found ?? this.app.workspace.getLeaf("tab");
   await leaf.setViewState({ type: AGENT_VIEW_TYPE, active: true }); await this.app.workspace.revealLeaf(leaf); return leaf;
  })().finally(() => { this.opening = undefined; });
  return this.opening;
 }
 viewClosed(closingLeaf: WorkspaceLeaf): void {
  if (!this.app.workspace.getLeavesOfType(AGENT_VIEW_TYPE).some(leaf => leaf !== closingLeaf)) {
   AuthModal.cancelAll(); void this.controller?.stop(); this.approvals?.cancelAll();
  }
 }
 onunload(): void {
  this.disposed = true; AuthModal.cancelAll(); ConnectionSettingsModal.cancelAll(); disposeProviderSettings(this); this.approvals?.cancelAll(); this.metadata?.dispose(); this.lifecycle?.dispose();
  this.catalog?.dispose();
  void this.controller?.dispose().catch(() => { new Notice("Chat history could not be saved while unloading. The latest conversation may not be stored."); }).finally(() => this.credentials?.dispose()); this.listeners.clear();
  if (!this.controller) this.credentials?.dispose();
 }
}
