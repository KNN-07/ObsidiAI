export interface ComposerTrigger { kind: "mention" | "skill"; start: number; end: number; query: string }
export interface ComposerChoice { kind: "file" | "folder" | "skill"; value: string; detail: string }

/** A mention extends to the caret, allowing spaces in visible vault paths. */
export function composerTrigger(value: string, caret: number): ComposerTrigger | null {
 const before = value.slice(0, caret);
 const slash = /^\s*\/(?:skill:)?([^\s]*)$/.exec(before);
 if (slash) return { kind: "skill", start: before.indexOf("/"), end: caret, query: slash[1] ?? "" };
 const mention = /(?:^|[\s([{])@([^@\n]*)$/.exec(before);
 if (!mention) return null;
 const start = before.lastIndexOf("@");
 return { kind: "mention", start, end: caret, query: mention[1] ?? "" };
}

/** AbstractInputSuggest's public contract excludes textarea; keep native DOM and one keyboard owner. */
export class ComposerSuggest {
 private readonly list: HTMLElement;
 private items: ComposerChoice[] = [];
 private selected = 0;
 private generation = 0;
 private disposed = false;
 private composing = false;
 private pending = false;
 private snapshot = "";
 private trigger: ComposerTrigger | null = null;
 private readonly listeners: (() => void)[] = [];
 constructor(private readonly input: HTMLTextAreaElement, container: HTMLElement,
  private readonly choices: (trigger: ComposerTrigger) => Promise<ComposerChoice[]>,
  private readonly choose: (choice: ComposerChoice) => void,
  private readonly send: () => void, private readonly enabled: () => boolean,
  private readonly changed: () => void) {
  this.list = container.createDiv({ cls: "obsidiai-composer-suggest", attr: { role: "listbox", "aria-label": "Draft context suggestions", id: `obsidiai-suggest-${crypto.randomUUID()}` } });
  this.list.hidden = true;
  input.setAttrs({ "aria-controls": this.list.id, "aria-autocomplete": "list", "aria-expanded": "false" });
  const listen = <K extends keyof HTMLElementEventMap>(name: K, handler: (event: HTMLElementEventMap[K]) => void) => {
   input.addEventListener(name, handler); this.listeners.push(() => input.removeEventListener(name, handler));
  };
  listen("input", () => { void this.refresh(); });
  listen("click", () => { void this.refresh(); });
  listen("keyup", event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) void this.refresh(); });
  listen("compositionstart", () => { this.composing = true; this.dismiss(); });
  listen("compositionend", () => { this.composing = false; void this.refresh(); });
  listen("blur", () => this.dismiss());
  listen("keydown", event => this.keydown(event));
 }
 dismiss(): void {
  this.generation++; this.pending = false; this.items = []; this.trigger = null; this.list.hidden = true;
  this.input.setAttribute("aria-expanded", "false"); this.input.removeAttribute("aria-activedescendant");
 }
 private async refresh(): Promise<void> {
  this.dismiss();
  if (this.disposed || this.composing || !this.enabled() || this.input.selectionStart !== this.input.selectionEnd) return;
  const snapshot = this.input.value, caret = this.input.selectionStart;
  const trigger = composerTrigger(snapshot, caret);
  if (!trigger) return;
  const generation = this.generation;
  this.trigger = trigger; this.pending = true;
  let items: ComposerChoice[];
  try { items = await this.choices(trigger); } catch { if (generation === this.generation) this.dismiss(); return; }
  if (this.disposed || generation !== this.generation) return;
  if (this.input.value !== snapshot || this.input.selectionStart !== caret || !this.enabled()) { this.dismiss(); return; }
  this.pending = false;
  this.items = items.slice(0, 40); this.selected = 0; this.snapshot = snapshot; this.trigger = trigger;
  if (!this.items.length) return;
  this.list.empty();
  for (const [index, item] of this.items.entries()) {
   const row = this.list.createDiv({ cls: "obsidiai-composer-option", attr: { role: "option", id: `${this.list.id}-${index}` } });
   row.createDiv({ text: item.kind === "skill" ? `/skill:${item.value}` : `${item.value}${item.kind === "folder" ? "/" : ""}` });
   row.createDiv({ cls: "obsidiai-composer-option-detail", text: item.detail });
   row.addEventListener("mousedown", event => event.preventDefault());
   row.addEventListener("click", () => { if (generation === this.generation) this.pick(index); });
  }
  this.list.hidden = false; this.input.setAttribute("aria-expanded", "true"); this.highlight();
 }
 private highlight(): void {
  Array.from(this.list.children).forEach((row, index) => row.setAttribute("aria-selected", String(index === this.selected)));
  const row = this.list.children[this.selected] as HTMLElement | undefined;
  if (row) {
   this.input.setAttribute("aria-activedescendant", row.id);
   if (row.offsetTop < this.list.scrollTop) this.list.scrollTop = row.offsetTop;
   else if (row.offsetTop + row.offsetHeight > this.list.scrollTop + this.list.clientHeight) this.list.scrollTop = row.offsetTop + row.offsetHeight - this.list.clientHeight;
  }
 }
 private keydown(event: KeyboardEvent): void {
  if (event.isComposing || this.composing || event.keyCode === 229) return;
  if (event.key === "Escape" && this.trigger) { event.preventDefault(); event.stopPropagation(); this.dismiss(); return; }
  if (this.items.length && ["ArrowDown", "ArrowUp"].includes(event.key)) {
   event.preventDefault(); this.selected = (this.selected + (event.key === "ArrowDown" ? 1 : -1) + this.items.length) % this.items.length; this.highlight(); return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
   event.preventDefault();
   if (this.pending) return;
   if (this.items.length) this.pick(this.selected); else { this.dismiss(); if (this.enabled()) this.send(); }
  }
 }
 private pick(index: number): void {
  const item = this.items[index], trigger = this.trigger;
  if (!item || !trigger || this.disposed || !this.enabled() || this.input.value !== this.snapshot || this.input.selectionStart !== trigger.end || this.input.selectionEnd !== trigger.end) { this.dismiss(); return; }
  // Skills stay in the canonical supported command form; text following the caret is untouched.
  const replacement = item.kind === "skill" ? `/skill:${item.value}${/^\s/.test(this.snapshot.slice(trigger.end)) ? "" : " "}` : "";
  this.input.setRangeText(replacement, trigger.start, trigger.end, "end");
  this.dismiss(); this.choose(item); this.changed(); this.input.focus();
 }
 dispose(): void { this.disposed = true; this.dismiss(); for (const remove of this.listeners) remove(); this.list.remove(); }
}
