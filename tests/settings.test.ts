import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
 ButtonComponent: class {},
 Modal: class {},
 Plugin: class {},
 PluginSettingTab: class {},
 Setting: class {},
}));
import { loadSettings, RECENT_MODEL_LIMIT, withRecentModel } from "../src/settings";

describe("recent models", () => {
 it("moves a reselected model to the front without duplicating it and keeps the limit", () => {
  let recent: { providerId: string; modelId: string }[] = [];
  for (const modelId of ["a", "b", "c", "d", "e"]) recent = withRecentModel(recent, "p", modelId);
  expect(recent.map(entry => entry.modelId)).toEqual(["e", "d", "c", "b"]);
  const before = recent;
  recent = withRecentModel(recent, "p", "c");
  expect(recent.map(entry => entry.modelId)).toEqual(["c", "e", "d", "b"]);
  expect(before.map(entry => entry.modelId)).toEqual(["e", "d", "c", "b"]);
  expect(withRecentModel(recent, "q", "c")).toEqual([{ providerId: "q", modelId: "c" }, ...recent.slice(0, RECENT_MODEL_LIMIT - 1)]);
 });

 it("loads only well-formed entries, strips extra fields, and defaults to empty", () => {
  expect(loadSettings({}).recentModels).toEqual([]);
  expect(loadSettings({ recentModels: "nope" }).recentModels).toEqual([]);
  const loaded = loadSettings({ recentModels: [null, { providerId: "p", modelId: "m", secret: "x" }, { providerId: 1, modelId: "m" }, { providerId: "p", modelId: "n" }, ...Array.from({ length: 6 }, (_, i) => ({ providerId: "p", modelId: `x${i}` }))] });
  expect(loaded.recentModels).toEqual([{ providerId: "p", modelId: "m" }, { providerId: "p", modelId: "n" }, { providerId: "p", modelId: "x0" }, { providerId: "p", modelId: "x1" }]);
 });
});
