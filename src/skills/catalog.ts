import { getFrontMatterInfo, parseYaml, TFile, TFolder, type App, type Plugin } from "obsidian";
import { validateVaultPath } from "../vault/paths";

export const MAX_SKILL_CHARACTERS = 200_000;
export interface SkillEntry {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly basePath: string;
  readonly manualOnly: boolean;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly allowedTools?: string;
}
export interface SkillDiagnostic { path: string; message: string }
interface SkillRecord { entry: SkillEntry; file: TFile; source: string; body: string }
export interface SkillSnapshot {
  readonly entries: readonly SkillEntry[];
  readonly revision: number;
  load(name: string): Promise<{ entry: SkillEntry; body: string }>;
  assertUnchanged(entry: SkillEntry): void;
}
const changedMessage = "Skill changed; start a new run to load it again";
const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/** Vault-local instruction catalog. Source bodies are never part of public entry metadata. */
export class SkillCatalog {
  entries: readonly SkillEntry[] = [];
  diagnostics: readonly SkillDiagnostic[] = [];
  private records = new Map<string, SkillRecord>();
  private dirty = true;
  private folder = "";
  private revision = 0;
  private catalogRevision = 0;
  private changes = new Map<string, number>();
  private refreshing: Promise<void> | null = null;
  private disposed = false;

  constructor(readonly app: App, private getFolder: () => string, owner: Plugin) {
    const mark = (path: string) => {
      const root = this.getFolder();
      if (this.disposed || !(within(path, root) || within(root, path))) return;
      this.revision++;
      this.changes.set(path, this.revision);
      this.dirty = true;
    };
    owner.registerEvent(app.vault.on("create", file => mark(file.path)));
    owner.registerEvent(app.vault.on("modify", file => mark(file.path)));
    owner.registerEvent(app.vault.on("delete", file => mark(file.path)));
    owner.registerEvent(app.vault.on("rename", (file, oldPath) => { mark(oldPath); mark(file.path); }));
  }

  async refresh(force = false): Promise<void> {
    if (this.disposed) throw new Error("Skill catalog has been disposed.");
    if (this.refreshing) { await this.refreshing; return this.refresh(force); }
    if (!force && !this.dirty && this.folder === this.getFolder()) return;
    this.refreshing = this.rebuild();
    try { await this.refreshing; } finally { this.refreshing = null; }
  }

  private async rebuild(): Promise<void> {
    const start = this.revision;
    const folder = this.getFolder();
    const diagnostics: SkillDiagnostic[] = [];
    const candidates = new Map<string, SkillRecord[]>();
    this.folder = folder;
    let validRoot = false;
    try {
      validateVaultPath(folder, this.app.vault.configDir);
      const root = this.app.vault.getAbstractFileByPath(folder);
      if (!(root instanceof TFolder)) diagnostics.push({ path: folder, message: "Skills folder is missing. Create a visible folder containing skill directories with SKILL.md files, or choose an existing folder." });
      else validRoot = true;
    } catch { diagnostics.push({ path: folder, message: "Choose a visible, vault-relative skills folder." }); }
    if (validRoot) {
      const files = this.app.vault.getMarkdownFiles().filter(file => within(file.path, folder) && file.name === "SKILL.md").sort((a, b) => a.path.localeCompare(b.path));
      for (let index = 0; index < files.length; index++) {
        const file = files[index]!;
        try {
          validateVaultPath(file.path, this.app.vault.configDir);
          const source = await this.app.vault.read(file);
          if (source.length > MAX_SKILL_CHARACTERS) throw new Error("Skill exceeds 200,000 characters.");
          const info = getFrontMatterInfo(source);
          if (!info.exists) throw new Error("Skill requires YAML frontmatter with name and description.");
          let data: unknown;
          try { data = parseYaml(info.frontmatter); } catch { throw new Error("Invalid skill YAML frontmatter."); }
          if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Skill frontmatter must be a mapping.");
          const fields = data as Record<string, unknown>;
          const name = Object.hasOwn(fields, "name") ? fields.name : undefined;
          const description = Object.hasOwn(fields, "description") ? fields.description : undefined;
          if (typeof name !== "string" || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Invalid skill name: use 1–64 lowercase letters, digits, and single separating hyphens.");
          if (typeof description !== "string" || !description.trim() || description.length > 1024) throw new Error("Skill description must contain 1–1,024 characters.");
          if (Object.hasOwn(fields, "disable-model-invocation") && typeof fields["disable-model-invocation"] !== "boolean") throw new Error("disable-model-invocation must be boolean.");
          const optional: { -readonly [K in "license" | "compatibility" | "metadata" | "allowedTools"]?: SkillEntry[K] } = {};
          for (const key of ["license", "compatibility"] as const) {
            if (Object.hasOwn(fields, key)) {
              if (typeof fields[key] !== "string") throw new Error(`${key} must be text.`);
              optional[key] = fields[key];
            }
          }
          if (Object.hasOwn(fields, "allowed-tools")) {
            if (typeof fields["allowed-tools"] !== "string") throw new Error("allowed-tools must be descriptive text.");
            optional.allowedTools = fields["allowed-tools"];
          }
          if (Object.hasOwn(fields, "metadata")) {
            const metadata = fields.metadata;
            if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || Object.values(metadata).some(value => typeof value !== "string")) throw new Error("Skill metadata must map keys to text values.");
            optional.metadata = Object.freeze(Object.fromEntries(Object.entries(metadata).filter(([key]) => !["__proto__", "constructor", "prototype"].includes(key)))) as Readonly<Record<string, string>>;
          }
          const entry = Object.freeze({ name, description, path: file.path, basePath: file.path.slice(0, -"/SKILL.md".length), manualOnly: fields["disable-model-invocation"] === true, ...optional });
          const record = { entry, file, source, body: source.slice(info.contentStart) };
          const group = candidates.get(name) ?? [];
          group.push(record);
          candidates.set(name, group);
        } catch (error) {
          diagnostics.push({ path: file.path, message: error instanceof Error && /^(Skill |Invalid skill|disable-model|license |compatibility |allowed-tools)/.test(error.message) ? error.message : "Skill could not be read or uses a prohibited path." });
        }
        if (index % 20 === 19) await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    }
    const records = new Map<string, SkillRecord>();
    for (const [name, group] of candidates) {
      if (group.length > 1) for (const record of group) diagnostics.push({ path: record.entry.path, message: `Duplicate skill name ${name}; all colliding entries are excluded.` });
      else records.set(name, group[0]!);
    }
    if (this.disposed) return;
    this.records = records;
    this.catalogRevision = start;
    this.entries = Object.freeze([...records.values()].map(record => record.entry).sort((a, b) => a.name.localeCompare(b.name)));
    this.diagnostics = diagnostics;
    this.dirty = start !== this.revision || folder !== this.getFolder();
  }

  capture(): SkillSnapshot {
    if (this.disposed) throw new Error("Skill catalog has been disposed.");
    const records = new Map(this.records);
    const revision = this.catalogRevision;
    const entries = this.entries;
    const folder = this.folder;
    const assertUnchanged = (entry: SkillEntry) => {
      if (folder !== this.getFolder()) throw new Error(changedMessage);
      for (const [path, changed] of this.changes) {
        if (changed > revision && (within(path, entry.basePath) || within(entry.basePath, path))) throw new Error(changedMessage);
      }
      const record = records.get(entry.name);
      if (!record || this.app.vault.getAbstractFileByPath(entry.path) !== record.file || record.file.path !== entry.path) throw new Error(changedMessage);
    };
    return {
      entries, revision, assertUnchanged,
      load: async name => {
        const record = records.get(name);
        if (!record) throw new Error("Unknown skill; refresh skills and choose an available name.");
        assertUnchanged(record.entry);
        let current: string;
        try { current = await this.app.vault.read(record.file); } catch { throw new Error(changedMessage); }
        assertUnchanged(record.entry);
        if (current !== record.source) throw new Error(changedMessage);
        return { entry: record.entry, body: record.body };
      },
    };
  }
  dispose(): void {
    this.disposed = true;
    this.records.clear(); this.changes.clear();
    this.entries = []; this.diagnostics = [];
  }
}
