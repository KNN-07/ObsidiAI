import type { PluginChangeProposal } from '../plugins/bridge';

export type NoteProposal = Readonly<{ kind: 'note-change'; operation: 'edit' | 'create'; path: string; before: string; after: string }>;
export type Proposal = NoteProposal | Readonly<{ kind: 'plugin-change'; change: PluginChangeProposal }>;
export type ApprovalDecision = 'approve' | 'reject';
export type PermissionMode = 'read-only' | 'ask' | 'auto-approve-notes';
export type PendingApproval = Readonly<{ id: string; proposal: Proposal }>;

export class ApprovalController {
  private permissionMode: PermissionMode = 'ask';
  private pending: { review: PendingApproval; settle: (decision: ApprovalDecision) => void } | null = null;
  private readonly listeners = new Set<(pending: boolean) => void>();
  get current(): PendingApproval | null { return this.pending?.review ?? null; }
  decide(id: string, decision: ApprovalDecision): void {
    if (this.pending?.review.id !== id) return;
    this.pending.settle(decision === 'approve' ? 'approve' : 'reject');
  }
  get mode(): PermissionMode { return this.permissionMode; }
  setMode(mode: PermissionMode): void {
    if (mode !== 'read-only' && mode !== 'ask' && mode !== 'auto-approve-notes') throw new Error('Invalid permission mode.');
    if (this.pending) throw new Error('Cannot change permissions while an approval is pending.');
    this.permissionMode = mode;
  }
  subscribe(listener: (pending: boolean) => void): () => void {
    this.listeners.add(listener);
    listener(this.pending !== null);
    return () => this.listeners.delete(listener);
  }
  private notify(): void { for (const listener of this.listeners) listener(this.pending !== null); }
  request(proposal: Proposal, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (signal?.aborted) return Promise.resolve('reject');
    if (this.pending) return Promise.reject(new Error('Another approval is already pending.'));
    if (this.permissionMode === 'read-only') return Promise.resolve('reject');
    if (this.permissionMode === 'auto-approve-notes' && proposal.kind === 'note-change') return Promise.resolve('approve');
    const { promise, resolve } = Promise.withResolvers<ApprovalDecision>();
    let settled = false;
    const abort = () => settle('reject');
    const settle = (decision: ApprovalDecision) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      this.pending = null;
      resolve(signal?.aborted ? 'reject' : decision);
      this.notify();
    };
    this.pending = { review: Object.freeze({ id: crypto.randomUUID(), proposal: Object.freeze({ ...proposal }) }), settle };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      this.notify();
      if (signal?.aborted) settle('reject');
    } catch {
      settle('reject');
    }
    return promise;
  }
  cancelAll(): void { this.pending?.settle('reject'); }
}
