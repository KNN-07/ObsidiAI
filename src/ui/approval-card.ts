import { ButtonComponent } from 'obsidian';
import { diffLines } from 'diff';
import type { ApprovalDecision, PendingApproval } from './approval';

export function renderApprovalCard(container: HTMLElement, pending: PendingApproval, decide: (decision: ApprovalDecision) => void): void {
  const { proposal } = pending;
  container.addClass('obsidiai-inline-approval');
  if (proposal.kind === 'note-change') {
    container.createEl('h3', { text: proposal.operation === 'create' ? 'Create note?' : 'Edit note?' });
    container.createEl('p', { text: proposal.path });
    const diff = container.createDiv({ cls: 'obsidiai-note-diff' });
    for (const part of diffLines(proposal.before, proposal.after)) {
      diff.createEl('pre', { text: part.value, cls: part.added ? 'obsidiai-diff-added' : part.removed ? 'obsidiai-diff-removed' : 'obsidiai-diff-context' });
    }
  } else {
    const { change } = proposal;
    container.createEl('h3', { text: `${change.action}: ${change.name}` });
    container.createEl('p', { text: `Community plugin ID: ${change.id}` });
    container.createEl('p', { text: `Installed: ${change.observed.version ?? 'absent'}; configured enabled: ${change.observed.configuredEnabled}; currently loaded: ${change.observed.loaded}.` });
    if (change.release) {
      container.createEl('p', { text: `Official registry repository: ${change.repo}; exact target: ${change.targetVersion}.` });
      container.createEl('p', { text: `Release manifest: ${change.release.source}` });
      container.createEl('p', { text: `Requires Obsidian ${change.release.manifest.minAppVersion}. ${change.release.olderCompatible ? 'An older compatible release was selected.' : 'Selected release is compatible with this host.'}` });
    }
    const warning = container.createDiv({ cls: 'obsidiai-plugin-warning' });
    warning.createEl('p', { text: 'Community plugins are unsandboxed. Third-party code can execute during native lifecycle operations with Obsidian privileges. Registry listing is not a security audit; assets and source code are not verified.' });
    if (change.action === 'uninstall') warning.createEl('p', { text: "Native uninstall may remove this plugin's files and saved settings; no backup is created" });
    const effects = container.createEl('ul');
    for (const effect of change.effects) effects.createEl('li', { text: effect });
    container.createEl('p', { text: 'Stop before the operation prevents mutation. Once a native operation starts, it cannot be cancelled or rolled back.' });
  }
  const controls = container.createDiv({ cls: 'obsidiai-approval-controls' });
  let settled = false;
  const choose = (decision: ApprovalDecision) => {
    if (settled) return;
    settled = true;
    reject.setDisabled(true); approve.setDisabled(true);
    decide(decision);
  };
  const reject = new ButtonComponent(controls).setButtonText('Reject').onClick(() => choose('reject'));
  const approve = new ButtonComponent(controls).setButtonText(proposal.kind === 'note-change' ? 'Approve' : proposal.change.action === 'uninstall' ? 'Uninstall plugin' : `Approve ${proposal.change.action}`).onClick(() => choose('approve'));
  if (proposal.kind === 'plugin-change') approve.setWarning(); else approve.setCta();
}
