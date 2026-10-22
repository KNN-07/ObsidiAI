import { setIcon } from "obsidian";

export interface PopoverItem {
 title: string;
 description?: string;
 icon?: string;
 /** Radio-style selection mark; `toggle` renders a switch instead. */
 checked?: boolean;
 toggle?: boolean;
 disabled?: boolean;
 tooltip?: string;
 /** Keep the menu open after the action, e.g. for toggles. */
 keepOpen?: boolean;
 action: () => void;
}
export interface PopoverSection { heading?: string; items: PopoverItem[] }
export interface PopoverContent { sections: PopoverSection[]; status?: string; empty?: string; note?: string; footer?: PopoverItem[] }
export interface PopoverOptions {
 label: string;
 searchPlaceholder?: string;
 width?: number;
 align?: "start" | "end";
 closed?: () => void;
}

/** An anchored menu inside the view, so it inherits view-scoped styles and closes with the view. */
export class Popover {
 private readonly el: HTMLElement;
 private readonly list: HTMLElement;
 private readonly search?: HTMLInputElement;
 private readonly cleanup: (() => void)[] = [];
 private buttons: HTMLButtonElement[] = [];
 private disposed = false;
 constructor(private readonly host: HTMLElement, private readonly anchor: HTMLElement, private readonly options: PopoverOptions, private readonly content: (query: string) => PopoverContent) {
  this.el = host.createDiv({ cls: "obsidiai-popover", attr: { role: "dialog", "aria-label": options.label } });
  if (options.searchPlaceholder) {
   const field = this.el.createDiv({ cls: "obsidiai-popover-search" });
   setIcon(field.createSpan({ attr: { "aria-hidden": "true" } }), "search");
   this.search = field.createEl("input", { type: "text", attr: { placeholder: options.searchPlaceholder, "aria-label": options.searchPlaceholder, spellcheck: "false" } });
   this.search.addEventListener("input", () => this.refresh());
  }
  this.list = this.el.createDiv({ cls: "obsidiai-popover-list", attr: { role: "menu", "aria-label": options.label } });
  this.el.addEventListener("keydown", event => this.keydown(event));
  const doc = host.doc, win = host.win;
  const outside = (event: MouseEvent) => {
   const target = event.target as Node | null;
   if (target && !this.el.contains(target) && !anchor.contains(target)) this.close(false);
  };
  const reposition = () => this.position();
  doc.addEventListener("mousedown", outside, true);
  win.addEventListener("resize", reposition);
  this.cleanup.push(() => doc.removeEventListener("mousedown", outside, true), () => win.removeEventListener("resize", reposition));
  anchor.setAttr("aria-expanded", "true");
  this.refresh();
  if (this.search) this.search.focus(); else (this.buttons.find(button => button.getAttr("aria-checked") === "true") ?? this.buttons[0])?.focus();
 }
 get isOpen(): boolean { return !this.disposed; }
 /** Rebuilds items while preserving the focused row where possible. */
 refresh(): void {
  if (this.disposed) return;
  const focused = this.buttons.indexOf(this.el.doc.activeElement as HTMLButtonElement);
  const { sections, status, empty, note, footer } = this.content(this.search?.value.trim().toLocaleLowerCase() ?? "");
  this.list.empty(); this.buttons = [];
  if (status) this.list.createDiv({ cls: "obsidiai-popover-status", text: status, attr: { role: "status" } });
  for (const section of sections) {
   if (!section.items.length) continue;
   const group = this.list.createDiv({ cls: "obsidiai-popover-section", attr: { role: "group" } });
   if (section.heading) { group.setAttr("aria-label", section.heading); group.createDiv({ cls: "obsidiai-popover-heading", text: section.heading }); }
   for (const item of section.items) this.renderItem(group, item);
  }
  if (!this.buttons.length && empty) this.list.createDiv({ cls: "obsidiai-popover-empty", text: empty });
  if (note) this.list.createDiv({ cls: "obsidiai-popover-note", text: note });
  if (footer?.length) { const group = this.list.createDiv({ cls: "obsidiai-popover-section obsidiai-popover-footer", attr: { role: "group" } }); for (const item of footer) this.renderItem(group, item); }
  if (focused >= 0) this.buttons[Math.min(focused, this.buttons.length - 1)]?.focus();
  this.position();
 }
 private renderItem(parent: HTMLElement, item: PopoverItem): void {
  const role = item.toggle ? "menuitemcheckbox" : item.checked === undefined ? "menuitem" : "menuitemradio";
  const button = parent.createEl("button", { cls: "obsidiai-popover-item", attr: { type: "button", role, tabindex: "-1" } });
  if (item.checked !== undefined) button.setAttr("aria-checked", String(item.checked));
  button.disabled = !!item.disabled;
  if (item.tooltip) button.setAttr("title", item.tooltip);
  if (item.icon) setIcon(button.createSpan({ cls: "obsidiai-popover-icon", attr: { "aria-hidden": "true" } }), item.icon);
  const copy = button.createSpan({ cls: "obsidiai-popover-copy" });
  copy.createSpan({ cls: "obsidiai-popover-title", text: item.title });
  if (item.description) copy.createSpan({ cls: "obsidiai-popover-description", text: item.description });
  if (item.toggle) button.createSpan({ cls: "obsidiai-popover-switch", attr: { "aria-hidden": "true" } });
  else if (item.checked) setIcon(button.createSpan({ cls: "obsidiai-popover-check", attr: { "aria-hidden": "true" } }), "check");
  button.addEventListener("click", () => {
   if (this.disposed || button.disabled) return;
   // Run synchronously so actions like a file picker keep the user gesture.
   if (!item.keepOpen) this.close(true);
   item.action();
  });
  button.addEventListener("mousemove", () => { if (this.el.doc.activeElement !== button && !button.disabled) button.focus({ preventScroll: true }); });
  this.buttons.push(button);
 }
 private keydown(event: KeyboardEvent): void {
  if (event.isComposing) return;
  const enabled = this.buttons.filter(button => !button.disabled);
  const index = enabled.indexOf(this.el.doc.activeElement as HTMLButtonElement);
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.close(true); }
  else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
   event.preventDefault();
   if (!enabled.length) return;
   const down = event.key === "ArrowDown";
   if (index < 0) (down ? enabled[0] : enabled.at(-1))?.focus();
   else if (!down && index === 0 && this.search) this.search.focus();
   else enabled[(index + (down ? 1 : -1) + enabled.length) % enabled.length]?.focus();
  } else if (event.key === "Home" && index >= 0) { event.preventDefault(); enabled[0]?.focus(); }
  else if (event.key === "End" && index >= 0) { event.preventDefault(); enabled.at(-1)?.focus(); }
  else if (event.key === "Enter" && event.target === this.search) { event.preventDefault(); enabled[0]?.click(); }
  else if (event.key === "Tab") { event.preventDefault(); this.close(true); }
  else if (this.search && index >= 0 && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) this.search.focus();
 }
 private position(): void {
  if (this.disposed) return;
  const host = this.host.getBoundingClientRect(), anchor = this.anchor.getBoundingClientRect(), gap = 6, edge = 8;
  const width = Math.min(this.options.width ?? 280, host.width - edge * 2);
  const preferred = this.options.align === "end" ? anchor.right - host.left - width : anchor.left - host.left;
  this.el.style.width = `${width}px`;
  this.el.style.left = `${Math.max(edge, Math.min(preferred, host.width - width - edge))}px`;
  const above = anchor.top - host.top - gap - edge, below = host.bottom - anchor.bottom - gap - edge;
  if (above >= below) { this.el.style.top = ""; this.el.style.bottom = `${host.bottom - anchor.top + gap}px`; this.el.style.maxHeight = `${Math.max(120, above)}px`; }
  else { this.el.style.bottom = ""; this.el.style.top = `${anchor.bottom - host.top + gap}px`; this.el.style.maxHeight = `${Math.max(120, below)}px`; }
 }
 /** Restores anchor focus only for dismissals from inside the menu, not outside clicks. */
 close(restoreFocus = false): void {
  if (this.disposed) return;
  this.disposed = true;
  for (const remove of this.cleanup) remove();
  this.anchor.setAttr("aria-expanded", "false");
  this.el.remove();
  if (restoreFocus) this.anchor.focus({ preventScroll: true });
  this.options.closed?.();
 }
}
