import { ButtonComponent } from 'obsidian';
import { diffLines } from 'diff';
import { MAX_SETTING_VALUE_CHARS, MAX_SHARED_SETTINGS_CHARS } from '../plugins/settings-types';
import type { ApprovalDecision, PendingApproval } from './approval';

export function renderApprovalCard(container: HTMLElement, pending: PendingApproval, decide: (decision: ApprovalDecision) => void): void {
  const { proposal } = pending;
  const selected = new Set<string>();
  const checkboxes: HTMLInputElement[] = [];
  let selectionStatus: HTMLElement | undefined;
  let selectionError: HTMLElement | undefined;
  let settled = false;
  container.addClass('obsidiai-inline-approval');
  const renderDiff = (before: string, after: string) => {
    const diff = container.createDiv({ cls: 'obsidiai-note-diff' });
    for (const part of diffLines(before, after)) {
      diff.createEl('pre', { text: part.value, cls: part.added ? 'obsidiai-diff-added' : part.removed ? 'obsidiai-diff-removed' : 'obsidiai-diff-context' });
    }
  };
  if (proposal.kind === 'note-change') {
    container.createEl('h3', { text: proposal.operation === 'create' ? 'Create note?' : 'Edit note?' });
    container.createEl('p', { text: proposal.path });
    renderDiff(proposal.before, proposal.after);
  } else if (proposal.kind === 'plugin-change') {
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
  } else {
    container.createEl('h3', { text: `${proposal.kind === 'plugin-settings-read' ? 'Share settings from' : 'Save settings for'} ${proposal.name}?` });
    container.createEl('p', { text: `Community plugin ID: ${proposal.pluginId}; installed version: ${proposal.version}.` });
    const warning = container.createDiv({ cls: 'obsidiai-plugin-warning' });
    if (proposal.kind === 'plugin-settings-read') {
      warning.createEl('p', { text: 'Only values you select will be sent to the selected model/provider and included in saved chat history. Settings may contain passwords, API keys, tokens, or other private information. Review each value before sharing. Nothing is selected automatically.' });
      container.createEl('p', { text: `Arrays are shared as whole values. Values over ${MAX_SETTING_VALUE_CHARS.toLocaleString()} characters cannot be selected; total sharing is limited to ${MAX_SHARED_SETTINGS_CHARS.toLocaleString()} characters. Continue without sharing values to allow proposals for new keys without disclosing existing values.` });
      const fields = container.createDiv({ cls: 'obsidiai-settings-fields' });
      for (const field of proposal.fields) {
        const row = fields.createDiv({ cls: 'obsidiai-settings-field' });
        const label = row.createEl('label');
        const checkbox = label.createEl('input', { attr: { type: 'checkbox' } });
        checkbox.checked = false;
        checkbox.disabled = !field.selectable;
        checkboxes.push(checkbox);
        label.createSpan({ text: field.path });
        const preview = row.createEl('details');
        preview.createEl('summary', { text: 'Review JSON value' });
        preview.createEl('pre', { text: field.valueJson, cls: 'obsidiai-settings-value' });
        if (!field.selectable) row.createEl('p', { text: 'This value is too large to share and cannot be selected.' });
        checkbox.addEventListener('change', () => {
          if (settled || pending.signal.aborted || !field.selectable) return;
          if (checkbox.checked) selected.add(field.path); else selected.delete(field.path);
          updateSelection();
        });
      }
      selectionStatus = container.createEl('p', { cls: 'obsidiai-settings-selection-status', attr: { 'aria-live': 'polite' } });
      selectionError = container.createEl('p', { cls: 'obsidiai-settings-selection-status', attr: { role: 'alert' } });
    } else {
      const { observed } = proposal;
      container.createEl('p', { text: `Configured enabled: ${observed.configuredEnabled}; currently loaded: ${observed.loaded}.` });
      warning.createEl('p', { text: observed.loaded || observed.configuredEnabled
        ? `Saving includes stopping the plugin and restoring its ${observed.configuredEnabled ? 'configured-enabled' : 'session-only loaded'} intent. This can restart third-party code with Obsidian privileges.`
        : 'The plugin will remain disabled and unloaded; saving does not approve enabling it.' });
      warning.createEl('p', { text: 'These are exact JSON changes, not schema-validated plugin settings. The plugin’s setting schema is unknown; valid JSON does not guarantee valid or effective runtime settings. No backup is created and no rollback is promised. Unshared settings are preserved.' });
      container.createEl('p', { text: 'Stop before mutation prevents saving. Once mutation starts, approved state restoration will finish even if you press Stop. Failures may leave partial state.' });
      for (const change of proposal.changes) {
        container.createEl('h4', { text: `${change.operation}: ${change.path}` });
        renderDiff(change.before, change.after);
      }
    }
  }
  const controls = container.createDiv({ cls: 'obsidiai-approval-controls' });
  const disable = () => {
    settled = true;
    reject.setDisabled(true); approve.setDisabled(true);
    for (const checkbox of checkboxes) checkbox.disabled = true;
    for (const details of container.querySelectorAll('details')) {
      const summary = details.querySelector('summary');
      if (summary) {
        summary.tabIndex = -1;
        summary.setAttribute('aria-disabled', 'true');
        summary.addEventListener('click', event => event.preventDefault());
      }
    }
    pending.signal.removeEventListener('abort', disable);
  };
  const choose = (decision: ApprovalDecision) => {
    if (settled || pending.signal.aborted) return;
    if (decision === 'approve' && proposal.kind === 'plugin-settings-read') {
      try {
        proposal.select([...selected]);
      } catch {
        if (selectionError) selectionError.textContent = `Selection could not be shared. Select fewer or smaller values (maximum ${MAX_SHARED_SETTINGS_CHARS.toLocaleString()} characters), or reject and inspect again.`;
        return;
      }
      if (pending.signal.aborted) return;
    }
    disable();
    decide(decision);
  };
  const reject = new ButtonComponent(controls).setButtonText('Reject').onClick(() => choose('reject'));
  const approve = new ButtonComponent(controls).setButtonText(proposal.kind === 'note-change' ? 'Approve'
    : proposal.kind === 'plugin-change' ? proposal.change.action === 'uninstall' ? 'Uninstall plugin' : `Approve ${proposal.change.action}`
    : proposal.kind === 'plugin-settings-change' ? 'Save settings' : 'Continue without sharing values').onClick(() => choose('approve'));
  function updateSelection(): void {
    if (selectionStatus) selectionStatus.textContent = `${selected.size} value${selected.size === 1 ? '' : 's'} selected.`;
    if (selectionError) selectionError.textContent = '';
    approve.setButtonText(selected.size === 0 ? 'Continue without sharing values' : `Share ${selected.size} selected value${selected.size === 1 ? '' : 's'}`);
  }
  if (proposal.kind === 'plugin-settings-read') updateSelection();
  if (proposal.kind === 'note-change') approve.setCta(); else approve.setWarning();
  pending.signal.addEventListener('abort', disable, { once: true });
  if (pending.signal.aborted) disable();
}
