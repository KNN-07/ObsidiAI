import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import type { App, Plugin } from "obsidian";

vi.mock("obsidian", () => {
  class TFile {
    path: string;
    name: string;
    extension: string;
    constructor(path: string) { this.path = path; this.name = path.split("/").at(-1)!; this.extension = this.name.split(".").at(-1)!; }
  }
  class TFolder { constructor(readonly path: string) {} }
  return {
    TFile, TFolder,
    parseYaml: (source: string) => parseYaml(source),
    getFrontMatterInfo: (source: string) => {
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
      return { exists: !!match, frontmatter: match?.[1] ?? "", contentStart: match?.[0].length ?? 0 };
    },
  };
});

import { TFile, TFolder } from "obsidian";
import { SkillCatalog } from "../src/skills/catalog";
import { SkillToolService } from "../src/agent/skill-tools";

function fixture(initial: Record<string, string>, root = "Skills") {
  const files = new Map<string, TFile>();
  const contents = new Map(Object.entries(initial));
  const folders = new Map<string, TFolder>();
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  for (const path of contents.keys()) {
    files.set(path, new (TFile as unknown as new(path: string) => TFile)(path));
    const segments = path.split("/");
    for (let n = 1; n < segments.length; n++) {
      const folder = segments.slice(0, n).join("/");
      folders.set(folder, new (TFolder as unknown as new(path: string) => TFolder)(folder));
    }
  }
  const app = { vault: {
    configDir: ".obsidian",
    getMarkdownFiles: () => [...files.values()].filter(file => file.extension === "md"),
    getAbstractFileByPath: (path: string) => files.get(path) ?? folders.get(path) ?? null,
    read: async (file: TFile) => { if (!contents.has(file.path)) throw new Error("Missing"); return contents.get(file.path)!; },
    on: (name: string, callback: (...args: unknown[]) => void) => { const group = handlers.get(name) ?? []; group.push(callback); handlers.set(name, group); return {}; },
  } } as unknown as App;
  const catalog = new SkillCatalog(app, () => root, { registerEvent() {} } as unknown as Plugin);
  const service = new SkillToolService(catalog);
  return {
    catalog, service,
    async execute(name: string, args: Record<string, unknown>) { return (await service.tools.find(tool => tool.name === name)!.execute("call", args)).details; },
    change(path: string, content: string) {
      contents.set(path, content);
      for (const callback of handlers.get("modify") ?? []) callback(files.get(path));
    },
    remove(path: string) {
      const file = files.get(path) ?? folders.get(path);
      files.delete(path); folders.delete(path); contents.delete(path);
      for (const callback of handlers.get("delete") ?? []) callback(file);
    },
  };
}
const skill = (name: string, body = "Review all links carefully.", extra = "") => `---\nname: ${name}\ndescription: Review vault links\n${extra}---\n${body}`;
const source = "Skills/review/SKILL.md";
const resource = "Skills/review/references/checklist.md";

describe("instruction-only vault skills", () => {
  it("discloses metadata first and gates resource reads on activation", async () => {
    const f = fixture({ [source]: skill("link-review", "PRIVATE INSTRUCTIONS", "allowed-tools: Bash\n"), [resource]: "Check destinations" });
    await f.service.beginRun([]);
    const listed = await f.execute("list_skills", {});
    expect(listed.skills).toEqual([expect.objectContaining({ name: "link-review", basePath: "Skills/review", allowedTools: "Bash" })]);
    expect(JSON.stringify(listed)).not.toContain("PRIVATE INSTRUCTIONS");
    expect(f.service.catalogPrompt()).not.toContain("PRIVATE INSTRUCTIONS");
    await expect(f.execute("read_skill_resource", { name: "link-review", path: "references/checklist.md" })).rejects.toThrow("Load or explicitly select");
    expect(await f.execute("load_skill", { name: "link-review" })).toMatchObject({ body: "PRIVATE INSTRUCTIONS", path: source });
    expect(await f.execute("read_skill_resource", { name: "link-review", path: "references/checklist.md" })).toMatchObject({ content: "Check destinations" });
    expect(f.service.tools.map(tool => tool.name)).toEqual(["list_skills", "load_skill", "read_skill_resource"]);
  });

  it("keeps manual-only skills out of discovery but accepts explicit user selection", async () => {
    const f = fixture({ [source]: skill("manual-review", "Manual instruction", "disable-model-invocation: true\n"), [resource]: "Checklist" });
    await f.service.beginRun([]);
    expect(f.catalog.entries[0]?.manualOnly).toBe(true);
    expect((await f.execute("list_skills", {})).skills).toEqual([]);
    expect(f.service.catalogPrompt()).not.toContain("manual-review");
    await expect(f.execute("load_skill", { name: "manual-review" })).rejects.toThrow("explicit user selection");
    await f.service.beginRun(["manual-review"]);
    const context = await f.service.selectedContext(["manual-review", "manual-review"], "Only links");
    expect(context).toContain("UNTRUSTED DATA");
    expect(context).toContain('"arguments":"Only links"');
    expect(context.match(/Manual instruction/g)).toHaveLength(1);
    expect(await f.execute("read_skill_resource", { name: "manual-review", path: "references/checklist.md" })).toMatchObject({ content: "Checklist" });
    await f.service.beginRun([]);
    await expect(f.execute("load_skill", { name: "manual-review" })).rejects.toThrow("explicit user selection");
  });

  it("excludes every duplicate and invalid YAML while ordinary empty-skill runs still work", async () => {
    const f = fixture({ [source]: skill("same"), "Skills/other/SKILL.md": skill("same"), "Skills/bad/SKILL.md": "---\nname: [broken\ndescription: nope\n---\nbody" });
    await f.service.beginRun([]);
    expect((await f.execute("list_skills", {})).skills).toEqual([]);
    expect(f.catalog.diagnostics.filter(d => d.message.includes("Duplicate"))).toHaveLength(2);
    expect(f.catalog.diagnostics.some(d => d.path === "Skills/bad/SKILL.md" && d.message.includes("YAML"))).toBe(true);
    expect(await f.service.selectedContext([])).toBe("");
    const missing = fixture({}, "Missing");
    await missing.service.beginRun([]);
    expect(missing.catalog.diagnostics[0]?.message).toContain("missing");
    expect((await missing.execute("list_skills", {})).skills).toEqual([]);
  });

  it("freezes run metadata and rejects changed instruction bodies until a fresh run", async () => {
    const f = fixture({ [source]: skill("link-review", "Original") });
    await f.service.beginRun([]);
    f.change(source, skill("new-review", "Changed"));
    await f.catalog.refresh();
    expect((await f.execute("list_skills", {})).skills[0].name).toBe("link-review");
    await expect(f.execute("load_skill", { name: "link-review" })).rejects.toThrow("Skill changed; start a new run");
    await f.service.beginRun([]);
    expect(await f.execute("load_skill", { name: "new-review" })).toMatchObject({ body: "Changed" });
  });

  it("rejects resource changes even before their first read and permits them on the next run", async () => {
    const f = fixture({ [source]: skill("link-review"), [resource]: "Original" });
    await f.service.beginRun([]);
    await f.execute("load_skill", { name: "link-review" });
    f.change(resource, "Changed");
    await expect(f.execute("read_skill_resource", { name: "link-review", path: "references/checklist.md" })).rejects.toThrow("Skill changed; start a new run");
    await expect(f.execute("load_skill", { name: "link-review" })).rejects.toThrow("Skill changed; start a new run");
    await f.service.beginRun([]);
    await f.execute("load_skill", { name: "link-review" });
    expect(await f.execute("read_skill_resource", { name: "link-review", path: "references/checklist.md" })).toMatchObject({ content: "Changed" });
    f.remove(source);
    await expect(f.execute("load_skill", { name: "link-review" })).rejects.toThrow("Skill changed; start a new run");
  });

  it("rejects traversal, script directories, hidden files, executable and binary resources", async () => {
    const f = fixture({ [source]: skill("link-review"), "Skills/review/binary.txt": "a\u0000b", "Skills/review/huge.txt": "x".repeat(200_001) });
    await f.service.beginRun([]);
    await f.execute("load_skill", { name: "link-review" });
    for (const path of ["../outside.md", "scripts/task.js", "scripts/task.md", ".hidden.md", "https://example.com/file.md", "task.js", "binary.txt", "huge.txt"]) {
      await expect(f.execute("read_skill_resource", { name: "link-review", path })).rejects.toThrow();
    }
    f.service.endRun();
    await expect(f.execute("load_skill", { name: "link-review" })).rejects.toThrow("active run");
  });

  it("bounds progressive disclosure to complete escaped entries and paginates the rest", async () => {
    const initial: Record<string, string> = {};
    for (let i = 0; i < 100; i++) initial[`Skills/s${i}/SKILL.md`] = `---\nname: skill-${i}\ndescription: '${"<tag>".repeat(100)}'\n---\nHidden body`;
    const f = fixture(initial);
    await f.service.beginRun([]);
    const prompt = f.service.catalogPrompt();
    expect(prompt.length).toBeLessThanOrEqual(20_000);
    expect(prompt).toContain("&lt;tag&gt;");
    expect(prompt.match(/<skill /g)?.length).toBe(prompt.match(/<\/skill>/g)?.length);
    expect(prompt).toContain("list_skills");
    const first = await f.execute("list_skills", { limit: 50 });
    const second = await f.execute("list_skills", { offset: first.nextOffset, limit: 50 });
    expect(first.truncated).toBe(true);
    expect(second.nextOffset).toBeNull();
    expect(new Set([...first.skills, ...second.skills].map(s => s.name)).size).toBe(100);
  });
});
