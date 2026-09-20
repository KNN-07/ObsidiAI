import { App, ButtonComponent, Modal } from 'obsidian';
import type { PluginChangeProposal } from '../plugins/bridge';

export class PluginApprovalModal extends Modal {
  private settled = false;
  constructor(app: App, private readonly change: PluginChangeProposal, private readonly onDecision: (decision: 'approve' | 'reject') => void) { super(app); }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('obsidiai-plugin-approval');
    contentEl.createEl('h2', { text: `${this.change.action}: ${this.change.name}` });
    contentEl.createEl('p', { text: `Community plugin ID: ${this.change.id}` });
    contentEl.createEl('p', { text: `Installed: ${this.change.observed.version ?? 'absent'}; configured enabled: ${this.change.observed.configuredEnabled}; currently loaded: ${this.change.observed.loaded}.` });
    if (this.change.release) {
      contentEl.createEl('p', { text: `Official registry repository: ${this.change.repo}; exact target: ${this.change.targetVersion}.` });
      contentEl.createEl('p', { text: `Release manifest: ${this.change.release.source}` });
      contentEl.createEl('p', { text: `Requires Obsidian ${this.change.release.manifest.minAppVersion}. ${this.change.release.olderCompatible ? 'An older compatible release was selected.' : 'Selected release is compatible with this host.'}` });
    }
    const warning = contentEl.createDiv({ cls: 'obsidiai-plugin-warning' });
    warning.createEl('p', { text: 'Community plugins are unsandboxed. Third-party code can execute during native lifecycle operations with Obsidian privileges. Registry listing is not a security audit; assets and source code are not verified.' });
    if (this.change.action === 'uninstall') warning.createEl('p', { text: "Native uninstall may remove this plugin's files and saved settings; no backup is created" });
    const effects = contentEl.createEl('ul');
    for (const effect of this.change.effects) effects.createEl('li', { text: effect });
    contentEl.createEl('p', { text: 'Stop before the operation prevents mutation. Once a native operation starts, it cannot be cancelled or rolled back.' });
    const controls = contentEl.createDiv({ cls: 'obsidiai-approval-actions' });
    const cancel = new ButtonComponent(controls).setButtonText('Cancel').onClick(() => this.decide('reject'));
    new ButtonComponent(controls).setButtonText(this.change.action === 'uninstall' ? 'Uninstall plugin' : `Approve ${this.change.action}`).setWarning().onClick(() => this.decide('approve'));
    cancel.buttonEl.focus();
  }
  private decide(decision: 'approve' | 'reject'): void {
    if (this.settled) return;
    this.settled = true;
    this.onDecision(decision);
    this.close();
  }
  onClose(): void {
    if (!this.settled) { this.settled = true; this.onDecision('reject'); }
    this.contentEl.empty();
  }
}
