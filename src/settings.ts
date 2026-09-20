import { App, ButtonComponent, Modal, Plugin, PluginSettingTab, Setting } from "obsidian";
import type { AuthType, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ProviderRuntime } from "./agent/runtime";
import type { ObsidianCredentialStore } from "./agent/credentials";
import { AuthModal, safeAuthError } from "./ui/auth-modal";
import { validateVaultPath } from "./vault/paths";

export interface ObsidiAISettings {
 providerId: string | null;
 modelId: string | null;
 thinkingLevel: ModelThinkingLevel;
 credentialSecretId: string;
 skillsFolder: string;
 autoAttachOpenNotes: boolean;
}
export function loadSettings(data: unknown): ObsidiAISettings {
 const stored = data !== null && typeof data === "object" ? data as Partial<ObsidiAISettings> : {};
 return {
  providerId: typeof stored.providerId === "string" ? stored.providerId : null,
  modelId: typeof stored.modelId === "string" ? stored.modelId : null,
  thinkingLevel: stored.thinkingLevel && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(stored.thinkingLevel) ? stored.thinkingLevel : "off",
  credentialSecretId: typeof stored.credentialSecretId === "string" && stored.credentialSecretId.length > 0 ? stored.credentialSecretId : `obsidiai-${crypto.randomUUID()}`,
  skillsFolder: typeof stored.skillsFolder === "string" ? stored.skillsFolder : "Skills",
  autoAttachOpenNotes: stored.autoAttachOpenNotes === true,
 };
}
export interface SettingsHost {
 app: App;
 settings: ObsidiAISettings;
 runtime: ProviderRuntime | null;
 credentials: ObsidianCredentialStore | null;
 saveSettings(): Promise<void>;
 isRunning(): boolean;
 subscribe(listener: () => void): () => void;
 connectionChanged(): Promise<void>;
 skillsStatus(): string;
 refreshSkills(): Promise<void>;
 pluginManagerStatus(): string;
}
interface ConnectionState { busy: boolean; message: string; listeners: Set<() => void> }
const connectionStates = new WeakMap<SettingsHost, ConnectionState>();
export function getConnectionBusy(host: SettingsHost): boolean { return connectionStates.get(host)?.busy ?? false; }
export function subscribeConnectionState(host: SettingsHost, listener: () => void): () => void {
 let state = connectionStates.get(host);
 if (!state) { state = { busy: false, message: "", listeners: new Set() }; connectionStates.set(host, state); }
 state.listeners.add(listener);
 return () => state.listeners.delete(listener);
}
export async function runConnectionOperation(host: SettingsHost, work: () => Promise<void>): Promise<void> {
 let state = connectionStates.get(host);
 if (!state) { state = { busy: false, message: "", listeners: new Set() }; connectionStates.set(host, state); }
 if (state.busy || host.isRunning()) throw new Error("Connection changes are unavailable while an operation is running.");
 state.busy = true;
 try {
  for (const listener of state.listeners) listener();
  await work();
 } finally {
  state.busy = false;
  for (const listener of state.listeners) listener();
 }
}
const providerDisposers = new WeakMap<SettingsHost, Set<() => void>>();
export function disposeProviderSettings(host: SettingsHost): void {
 for (const dispose of providerDisposers.get(host) ?? []) dispose();
 providerDisposers.delete(host);
}

class ResetCredentialsModal extends Modal {
 private settled = false;
 constructor(app: App, private readonly decision: (reset: boolean) => void) { super(app); }
 onOpen(): void {
  this.contentEl.createEl("h2", { text: "Reset plugin credentials?" });
  this.contentEl.createEl("p", { text: "This replaces only ObsidiAI's credential secret with an empty object. All plugin-stored provider logins will be removed. Ambient environment/profile credentials and other applications are not changed." });
  const cancel = new ButtonComponent(this.contentEl).setButtonText("Cancel").onClick(() => this.close());
  new ButtonComponent(this.contentEl).setButtonText("Reset plugin credentials").setWarning().onClick(() => { this.settled = true; this.decision(true); this.close(); });
  cancel.buttonEl.focus();
 }
 onClose(): void { if (!this.settled) this.decision(false); this.contentEl.empty(); }
}

/** Shared by the tab and modal. The disposer cancels its pending network and login UI. */
export function renderProviderSettings(containerEl: HTMLElement, host: SettingsHost): () => void {
 let state = connectionStates.get(host);
 if (!state) { state = { busy: false, message: "", listeners: new Set() }; connectionStates.set(host, state); }
 const shared = state;
 let disposed = false;
 let generation = 0;
 let probe: AbortController | undefined;
 let operation: AbortController | undefined;
 let login: AuthModal | undefined;
 let confirmation: ResetCredentialsModal | undefined;
 let managedProviderId: string | null = null;
 const notify = () => { for (const listener of shared.listeners) listener(); };
 const perform = async (work: (signal: AbortSignal) => Promise<void>) => {
  if (disposed || shared.busy || host.isRunning()) return;
  const controller = new AbortController();
  shared.message = "";
  operation = controller;
  try { await runConnectionOperation(host, () => work(controller.signal)); }
  catch (error) { shared.message = safeAuthError(error); }
  finally { operation = undefined; notify(); }
 };
 const refresh = async (providerId: string, signal: AbortSignal) => {
  const result = await host.runtime!.models.refresh({ providers: [providerId], force: true, signal });
  if (result.aborted) shared.message = "Model refresh cancelled. The previous catalog is retained.";
  else if (result.errors.size) shared.message = "Model refresh failed. The previous catalog and successfully saved login are retained. Check connection/account entitlement and refresh again.";
 };
 const draw = () => {
  if (disposed) return;
  const current = ++generation;
  probe?.abort();
  probe = new AbortController();
  const signal = probe.signal;
  containerEl.empty();
  containerEl.addClass("obsidiai-connection-settings");
  const disabled = host.isRunning() || shared.busy;
  const models = host.runtime?.models;
  if (shared.message) containerEl.createEl("p", { text: shared.message, cls: "obsidiai-status" });
  if (host.credentials?.storageError) containerEl.createEl("p", { text: host.credentials.storageError, cls: "obsidiai-error" });
  new Setting(containerEl).setName("Automatically attach open notes")
   .setDesc("Off by default. On Send, include current open visible Markdown notes, including unsaved editor changes, unless excluded in the composer. Their contents are sent to the selected provider and retained in saved chat history. Enabling this alone sends nothing.")
   .addToggle(toggle => toggle.setValue(host.settings.autoAttachOpenNotes).setDisabled(disabled).onChange(value => {
    void perform(async () => {
     const previous = host.settings.autoAttachOpenNotes;
     host.settings.autoAttachOpenNotes = value;
     try { await host.saveSettings(); }
     catch (error) { host.settings.autoAttachOpenNotes = previous; throw error; }
    });
   }));
  containerEl.createEl("h3", { text: "Saved provider logins" });
  containerEl.createEl("p", { text: "One saved login per provider. Adding or reconnecting a provider does not change your chat selection. Saved login metadata does not verify remote access. Ambient environment/profile authentication remains available separately." });
  const savedArea = containerEl.createDiv();
  if (host.credentials) {
   savedArea.createEl("p", { text: "Loading saved logins…" });
   void host.credentials.list({ signal }).then(entries => {
    if (disposed || current !== generation || signal.aborted) return;
    savedArea.empty();
    if (!entries.length) savedArea.createEl("p", { text: "No plugin-stored logins." });
    for (const entry of entries) {
     const savedProvider = models?.getProvider(entry.providerId);
     new Setting(savedArea)
      .setName(savedProvider ? `${savedProvider.name} (${entry.providerId})` : entry.providerId)
      .setDesc(`${entry.type === "oauth" ? "OAuth" : "API key"} · ${host.settings.providerId === entry.providerId ? "Active chat provider" : "Not selected for chat"}${savedProvider ? "" : " · Provider unavailable in the registry"}`)
      .addButton(button => button.setButtonText("Manage").setDisabled(disabled).onClick(() => {
       if (disposed || shared.busy || host.isRunning()) return;
       managedProviderId = entry.providerId;
       draw();
      }))
      .addButton(button => button.setButtonText("Disconnect").setDisabled(disabled).onClick(() => { void perform(async signal => {
       if (savedProvider && models) await models.logout(entry.providerId, { signal });
       else await host.credentials!.delete(entry.providerId, { signal });
       shared.message = "Plugin-stored login removed. Ambient environment/profile authentication may still be available.";
       if (host.settings.providerId === entry.providerId) await host.connectionChanged();
      }); }));
    }
   }).catch(error => {
    if (!disposed && current === generation && !signal.aborted) { savedArea.empty(); savedArea.createEl("p", { text: safeAuthError(error), cls: "obsidiai-error" }); }
   });
  } else savedArea.createEl("p", { text: "Plugin credential storage is unavailable." });
  if (!models) containerEl.createEl("p", { text: "Agent runtime unavailable. Update the Obsidian desktop installer if its embedded Node runtime is unsupported." });
  else {
   const providerId = host.settings.providerId;
   const provider = providerId ? models.getProvider(providerId) : undefined;
   new Setting(containerEl).setName("Chat provider").setDesc("Choose explicitly; no provider or billable model is selected automatically. This selection is separate from managing saved logins.").addDropdown(dropdown => {
    dropdown.addOption("", "Choose a provider");
    for (const item of models.getProviders()) dropdown.addOption(item.id, item.name);
    dropdown.setValue(provider?.id ?? "").setDisabled(disabled);
    dropdown.onChange(value => { void perform(async () => {
     const previousProvider = host.settings.providerId, previousModel = host.settings.modelId;
     host.settings.providerId = value || null;
     host.settings.modelId = null;
     try { await host.saveSettings(); }
     catch (error) { host.settings.providerId = previousProvider; host.settings.modelId = previousModel; throw error; }
     await host.connectionChanged();
    }); });
   });
   if (providerId && !provider) containerEl.createEl("p", { text: "The saved provider is no longer in the registry. Select a provider; no replacement was chosen." });
   containerEl.createEl("h3", { text: "Manage authentication" });
   new Setting(containerEl).setName("Add / manage provider").setDesc("Choose any registry provider to add or replace its single saved login. Other providers stay connected; your chat provider and model stay unchanged.").addDropdown(dropdown => {
    dropdown.addOption("", "Choose a provider to connect");
    for (const item of models.getProviders()) dropdown.addOption(item.id, item.name);
    dropdown.setValue(managedProviderId && models.getProvider(managedProviderId) ? managedProviderId : "").setDisabled(disabled);
    dropdown.onChange(value => {
     if (disposed || shared.busy || host.isRunning()) return;
     managedProviderId = value || null;
     draw();
    });
   });
   const managedProvider = managedProviderId ? models.getProvider(managedProviderId) : undefined;
   if (managedProviderId && !managedProvider) containerEl.createEl("p", { text: "This provider is no longer available in the registry. Its saved login can still be removed with Disconnect above." });
   if (managedProvider) {
    const authenticate = (type: AuthType) => { void perform(async signal => {
     login = new AuthModal(host.app, managedProvider.name);
     const cancel = () => login?.cancel();
     signal.addEventListener("abort", cancel, { once: true });
     login.open();
     try {
      await models.login(managedProvider.id, type, login);
      login.finish();
      shared.message = "Login saved. Provider policy and account entitlement determine model access.";
      try { if (!disposed && !signal.aborted) await refresh(managedProvider.id, signal); }
      finally { if (host.settings.providerId === managedProvider.id) await host.connectionChanged(); }
     } finally { signal.removeEventListener("abort", cancel); login?.finish(); login = undefined; }
    }); };
    if (managedProvider.auth.apiKey) {
     const auth = managedProvider.auth.apiKey;
     const setting = new Setting(containerEl).setName(auth.name);
     if (auth.login) setting.addButton(button => button.setButtonText("Connect / reconnect").setDisabled(disabled || !host.credentials).onClick(() => authenticate("api_key")));
     else setting.setDesc("Ambient authentication only. Configure this provider's environment or native profile; no interactive API-key login is advertised.");
    }
    if (managedProvider.auth.oauth) new Setting(containerEl).setName(managedProvider.auth.oauth.name).setDesc("Advertised by the provider; successful access depends on network, provider policy and your account entitlement.").addButton(button => button.setButtonText(managedProvider.auth.oauth!.loginLabel ?? "Sign in / reconnect").setDisabled(disabled || !host.credentials).onClick(() => authenticate("oauth")));
    if (!managedProvider.auth.apiKey && !managedProvider.auth.oauth) containerEl.createEl("p", { text: "This provider advertises no interactive login methods. Ambient environment/profile authentication may be available." });
    new Setting(containerEl).setName("Provider catalog").addButton(button => button.setButtonText("Refresh models").setDisabled(disabled).onClick(() => { void perform(async signal => {
     await refresh(managedProvider.id, signal);
     if (!disposed && !signal.aborted && host.settings.providerId === managedProvider.id) await host.connectionChanged();
    }); }));
   }
   if (provider) {
    containerEl.createEl("h3", { text: "Active chat model" });
    const authStatus = containerEl.createEl("p", { text: "Checking authentication…" });
    const modelArea = containerEl.createDiv();
    void Promise.all([models.checkAuth(provider.id, { signal }), models.getAvailable(provider.id, { signal })]).then(([auth, available]) => {
     if (disposed || current !== generation || signal.aborted) return;
     authStatus.setText(auth ? `Configured (${auth.type}); account-specific availability shown below.` : "Disconnected. Connect a login method or configure ambient credentials.");
     const allowed = new Set(available.map(model => model.id));
     const catalog = models.getModels(provider.id);
     new Setting(modelArea).setName("Model").setDesc("Unavailable models require a configured credential with access; they cannot be selected.").addDropdown(dropdown => {
      dropdown.addOption("", "Choose an available model");
      for (const model of catalog) {
       dropdown.addOption(model.id, `${model.name}${allowed.has(model.id) ? "" : " — unavailable for current credentials"}`);
       if (!allowed.has(model.id)) dropdown.selectEl.options[dropdown.selectEl.options.length - 1]!.disabled = true;
      }
      const selected = host.settings.modelId;
      dropdown.setValue(selected && allowed.has(selected) ? selected : "").setDisabled(disabled);
      dropdown.onChange(value => { void perform(async signal => {
       const fresh = await models.getAvailable(provider.id, { signal });
       if (host.isRunning() || host.settings.providerId !== provider.id || (value && !fresh.some(model => model.id === value))) throw new Error("Model selection unavailable");
       const previousModel = host.settings.modelId;
       host.settings.modelId = value || null;
       try { await host.saveSettings(); }
       catch (error) { host.settings.modelId = previousModel; throw error; }
       await host.connectionChanged();
      }); });
     });
     if (!catalog.length) modelArea.createEl("p", { text: "This provider's catalog is empty. Connect and refresh models; no fallback model is chosen." });
     if (host.settings.modelId && !allowed.has(host.settings.modelId)) modelArea.createEl("p", { text: "The saved model is unknown or unavailable for these credentials. It remains unselected; choose an available model." });
    }).catch(error => { if (!disposed && current === generation && !signal.aborted) authStatus.setText(safeAuthError(error)); });
   }
  }
  new Setting(containerEl).setName("Reset plugin credentials").setDesc("Explicitly clear only this plugin's secret, including malformed storage.").addButton(button => button.setButtonText("Reset plugin credentials…").setDisabled(disabled || !host.credentials).onClick(() => {
   if (host.isRunning() || shared.busy) return;
   confirmation = new ResetCredentialsModal(host.app, reset => {
    confirmation = undefined;
    if (reset) void perform(async signal => { await host.credentials!.reset({ signal }); await host.connectionChanged(); shared.message = "Plugin credentials reset."; });
   });
   confirmation.open();
  }));
  if (host.isRunning()) containerEl.createEl("p", { text: "Connection changes are disabled until the active run settles." });
 };
 shared.listeners.add(draw);
 const unsubscribe = host.subscribe(draw);
 draw();
 const dispose = () => {
  if (disposed) return;
  disposed = true; generation++; probe?.abort(); operation?.abort(); login?.cancel(); confirmation?.close();
  shared.listeners.delete(draw); unsubscribe(); containerEl.empty();
  providerDisposers.get(host)?.delete(dispose);
 };
 let disposers = providerDisposers.get(host);
 if (!disposers) { disposers = new Set(); providerDisposers.set(host, disposers); }
 disposers.add(dispose);
 return dispose;
}

export class ConnectionSettingsModal extends Modal {
 private static readonly active = new Set<ConnectionSettingsModal>();
 static cancelAll(): void { for (const modal of [...this.active]) modal.close(); }
 private disposeRenderer?: () => void;
 constructor(app: App, private readonly host: SettingsHost) { super(app); }
 onOpen(): void { ConnectionSettingsModal.active.add(this); this.contentEl.createEl("h2", { text: "ObsidiAI connection" }); this.disposeRenderer = renderProviderSettings(this.contentEl.createDiv(), this.host); }
 onClose(): void { ConnectionSettingsModal.active.delete(this); this.disposeRenderer?.(); this.disposeRenderer = undefined; this.contentEl.empty(); }
}

export class ObsidiAISettingTab extends PluginSettingTab {
 private disposeRenderer?: () => void;
 constructor(app: App, plugin: Plugin, private readonly host: SettingsHost) { super(app, plugin); }
 display(): void {
  this.disposeRenderer?.();
  this.containerEl.empty();
  this.containerEl.createEl("h2", { text: "ObsidiAI" });
  this.disposeRenderer = renderProviderSettings(this.containerEl.createDiv(), this.host);
  const skillStatus = this.containerEl.createEl("p", { text: this.host.skillsStatus() });
  if (!this.host.isRunning()) void this.host.refreshSkills().then(() => { if (skillStatus.isConnected) skillStatus.setText(this.host.skillsStatus()); }).catch(() => { if (skillStatus.isConnected) skillStatus.setText("Skills could not be refreshed. Check the configured folder."); });
  const folder = new Setting(this.containerEl).setName("Skills folder").setDesc("Visible vault-relative folder. Missing folders are not created automatically.");
  let draft = this.host.settings.skillsFolder;
  folder.addText(text => text.setValue(draft).onChange(value => { draft = value; }));
  folder.addButton(button => button.setButtonText("Save folder").onClick(async () => {
   if (this.host.isRunning()) { skillStatus.setText("Wait for the current run before changing the skills folder."); return; }
   try {
    const validated = validateVaultPath(draft, this.app.vault.configDir);
    this.host.settings.skillsFolder = validated;
    await this.host.saveSettings();
    await this.host.refreshSkills();
    skillStatus.setText(this.host.skillsStatus());
   } catch { skillStatus.setText("Skills folder must be a visible vault-relative folder. The folder could not be saved or refreshed."); }
  }));
  new Setting(this.containerEl).setName("Skill discovery").addButton(button => button.setButtonText("Refresh skills").onClick(async () => {
   if (this.host.isRunning()) { skillStatus.setText("Wait for the current run before refreshing skills."); return; }
   try { await this.host.refreshSkills(); skillStatus.setText(this.host.skillsStatus()); }
   catch { skillStatus.setText("Skills could not be refreshed. Check the configured folder."); }
  }));
  this.containerEl.createEl("h3", { text: "Community plugin management" });
  this.containerEl.createEl("p", { text: this.host.pluginManagerStatus() });
  this.containerEl.createEl("p", { text: "Uses a private, version-sensitive native API. Each mutation requires separate approval. Community plugins are unsandboxed; installation/enabling can execute code with Obsidian privileges." });
 }
 hide(): void { this.disposeRenderer?.(); this.disposeRenderer = undefined; }
}
