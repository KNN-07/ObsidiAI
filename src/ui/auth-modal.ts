import { App, ButtonComponent, DropdownComponent, Modal } from "obsidian";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";

export function safeAuthError(error: unknown): string {
 if (error instanceof Error && error.name === "AbortError") return "Authentication cancelled.";
 const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
 if (code === "oauth") return "Authentication expired or was rejected. Reconnect to try again.";
 if (code === "auth") return "Credential access failed. Check plugin credential storage and reconnect.";
 return "Authentication or network operation failed. Check your connection and account entitlement, then reconnect.";
}

/** Settles each prompt once; cancelling a callback-raced prompt does not abort login. */
export class PendingAuthPrompt {
 readonly promise: Promise<string>;
 private settle!: (value?: string) => void;
 constructor(signals: readonly (AbortSignal | undefined)[], cleanup: () => void) {
  this.promise = new Promise<string>((resolve, reject) => {
   let settled = false;
   const abort = () => this.settle();
   this.settle = value => {
    if (settled) return;
    settled = true;
    for (const signal of signals) signal?.removeEventListener("abort", abort);
    cleanup();
    if (value === undefined) reject(new DOMException("Authentication prompt cancelled", "AbortError"));
    else resolve(value);
   };
   for (const signal of signals) signal?.addEventListener("abort", abort, { once: true });
   if (signals.some(signal => signal?.aborted)) this.settle();
  });
 }
 accept(value: string): void { this.settle(value); }
 cancel(): void { this.settle(); }
}

export class AuthModal extends Modal implements AuthInteraction {
 private static readonly active = new Set<AuthModal>();
 private readonly controller = new AbortController();
 readonly signal = this.controller.signal;
 private pending = new Set<PendingAuthPrompt>();
 private events!: HTMLElement;
 private prompts!: HTMLElement;
 private finished = false;
 constructor(app: App, private readonly providerName: string) { super(app); }
 static cancelAll(): void { for (const modal of [...this.active]) modal.cancel(); }
 onOpen(): void {
  AuthModal.active.add(this);
  this.contentEl.addClass("obsidiai-auth");
  this.contentEl.createEl("h2", { text: `Connect ${this.providerName}` });
  this.events = this.contentEl.createDiv();
  this.prompts = this.contentEl.createDiv();
  new ButtonComponent(this.contentEl).setButtonText("Cancel login").onClick(() => this.cancel());
 }
 cancel(): void { this.controller.abort(); this.close(); }
 finish(): void { this.finished = true; this.close(); }
 onClose(): void {
  AuthModal.active.delete(this);
  if (!this.finished) this.controller.abort();
  for (const prompt of this.pending) prompt.cancel();
  this.pending.clear();
  this.contentEl.querySelectorAll("input").forEach(input => { input.value = ""; });
  this.contentEl.empty();
 }
 prompt(prompt: AuthPrompt): Promise<string> {
  if (this.signal.aborted || this.finished) return Promise.reject(new DOMException("Login cancelled", "AbortError"));
  const row = this.prompts.createDiv({ cls: "obsidiai-auth-prompt" });
  const label = row.createEl("label", { text: prompt.message });
  let value: () => string;
  let input: HTMLInputElement | undefined;
  if (prompt.type === "select") {
   const dropdown = new DropdownComponent(label);
   dropdown.addOption("", "Choose an option");
   for (const option of prompt.options) dropdown.addOption(option.id, option.description ? `${option.label} — ${option.description}` : option.label);
   value = () => dropdown.getValue();
   dropdown.selectEl.focus();
  } else {
   input = label.createEl("input", { type: prompt.type === "secret" ? "password" : "text", placeholder: prompt.placeholder ?? "" });
   input.autocomplete = "off";
   input.spellcheck = false;
   value = () => input!.value;
   input.focus();
  }
  const pending = new PendingAuthPrompt([this.signal, prompt.signal], () => {
   if (input) input.value = "";
   row.remove();
  });
  this.pending.add(pending);
  const submit = () => {
   const answer = value();
   if (prompt.type === "select" && !prompt.options.some(option => option.id === answer)) return;
   pending.accept(answer);
  };
  new ButtonComponent(row).setButtonText("Continue").setCta().onClick(submit);
  input?.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); submit(); } });
  return pending.promise.finally(() => { this.pending.delete(pending); });
 }
 private link(container: HTMLElement, url: string, label = "Open browser"): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { container.createEl("p", { text: "Provider supplied an invalid browser URL." }); return; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") { container.createEl("p", { text: "Only HTTP and HTTPS authentication links can be opened." }); return; }
  container.createEl("p", { text: parsed.href });
  new ButtonComponent(container).setButtonText(label).onClick(() => {
   const { shell } = require("electron") as { shell: { openExternal(url: string): Promise<void> } };
   void shell.openExternal(parsed.href).catch(() => container.createEl("p", { text: "Could not open the browser. Open the displayed address manually." }));
  });
 }
 notify(event: AuthEvent): void {
  if (this.signal.aborted || this.finished) return;
  if (event.type === "progress") {
   let progress = this.events.querySelector<HTMLElement>(".obsidiai-auth-progress");
   progress ??= this.events.createEl("p", { cls: "obsidiai-auth-progress" });
   progress.setText(event.message);
   return;
  }
  const row = this.events.createDiv();
  if (event.type === "info") {
   row.createEl("p", { text: event.message });
   for (const link of event.links ?? []) this.link(row, link.url, link.label);
  } else if (event.type === "auth_url") {
   if (event.instructions) row.createEl("p", { text: event.instructions });
   this.link(row, event.url);
  } else {
   row.createEl("p", { text: "Enter this device code in your browser:" });
   row.createEl("code", { text: event.userCode });
   this.link(row, event.verificationUri);
  }
 }
}
