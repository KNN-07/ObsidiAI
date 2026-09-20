import { App, ButtonComponent, Modal } from 'obsidian';
import { diffLines } from 'diff';
import type { PluginChangeProposal } from '../plugins/bridge';
import { PluginApprovalModal } from './plugin-approval-modal';

export type NoteProposal = Readonly<{ kind: 'note-change'; operation: 'edit' | 'create'; path: string; before: string; after: string }>;
export type Proposal = NoteProposal | Readonly<{ kind: 'plugin-change'; change: PluginChangeProposal }>;
export type ApprovalDecision = 'approve' | 'reject';

export class ApprovalModal extends Modal {
  private decided = false;
  constructor(app: App, private readonly proposal: NoteProposal, private readonly onDecision: (decision: ApprovalDecision) => void) { super(app); }
  onOpen(): void {
    this.setTitle(this.proposal.operation === 'create' ? 'Create note?' : 'Edit note?');
    this.contentEl.createEl('p', { text: this.proposal.path });
    const diff = this.contentEl.createDiv({ cls: 'obsidiai-note-diff' });
    for (const part of diffLines(this.proposal.before, this.proposal.after)) {
      diff.createEl('pre', { text: part.value, cls: part.added ? 'obsidiai-diff-added' : part.removed ? 'obsidiai-diff-removed' : 'obsidiai-diff-context' });
    }
    const controls = this.contentEl.createDiv({ cls: 'obsidiai-approval-controls' });
    const reject = new ButtonComponent(controls).setButtonText('Reject').onClick(() => this.decide('reject'));
    new ButtonComponent(controls).setButtonText('Approve').setCta().onClick(() => this.decide('approve'));
    reject.buttonEl.focus();
  }
  private decide(decision: ApprovalDecision): void {
    if (this.decided) return;
    this.decided = true;
    this.onDecision(decision);
    this.close();
  }
  onClose(): void {
    if (!this.decided) {
      this.decided = true;
      this.onDecision('reject');
    }
    this.contentEl.empty();
  }
}

export class ApprovalController {
  private pending: { settle: (decision: ApprovalDecision) => void } | null = null;
  private readonly listeners = new Set<(pending: boolean) => void>();
  constructor(private readonly app: App) {}
  subscribe(listener: (pending: boolean) => void): () => void {
    this.listeners.add(listener);
    listener(this.pending !== null);
    return () => this.listeners.delete(listener);
  }
  private notify(): void { for (const listener of this.listeners) listener(this.pending !== null); }
  request(proposal: Proposal, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (signal?.aborted) return Promise.resolve('reject');
    if (this.pending) return Promise.reject(new Error('Another approval is already pending.'));
    const { promise, resolve } = Promise.withResolvers<ApprovalDecision>();
    let settled = false;
    let modal: Modal | undefined;
    const abort = () => settle('reject');
    const settle = (decision: ApprovalDecision) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      this.pending = null;
      modal?.close();
      resolve(signal?.aborted ? 'reject' : decision);
      this.notify();
    };
    this.pending = { settle };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      modal = proposal.kind === 'note-change'
        ? new ApprovalModal(this.app, Object.freeze({ ...proposal }), settle)
        : new PluginApprovalModal(this.app, proposal.change, settle);
      this.notify();
      if (signal?.aborted || settled) settle('reject');
      else modal.open();
    } catch {
      settle('reject');
    }
    return promise;
  }
  cancelAll(): void { this.pending?.settle('reject'); }
}
