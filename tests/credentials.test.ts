import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { Credential } from "@earendil-works/pi-ai";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { ObsidianCredentialStore } from "../src/agent/credentials";

function fixture(initial: string | null = null) {
 const secrets = new Map<string, string>();
 if (initial !== null) secrets.set("obsidiai-test", initial);
 secrets.set("other-plugin", "untouched");
 let fail = false;
 const app = { secretStorage: {
  getSecret: (id: string) => secrets.get(id) ?? null,
  setSecret: (id: string, value: string) => { if (fail) throw new Error("sensitive upstream error"); secrets.set(id, value); },
 } } as unknown as App;
 return { store: new ObsidianCredentialStore(app, "obsidiai-test"), secrets, fail: () => { fail = true; } };
}
const token: Credential = { type: "oauth", access: "access-0", refresh: "refresh-0", expires: 1, account: { id: "private" } };

describe("plugin-owned credential storage", () => {
 it("resolves concurrent real Models OAuth requests from one coherent refresh", async () => {
  const { store } = fixture(JSON.stringify({ provider: token }));
  const models = createModels({ credentials: store });
  const faux = fauxProvider({ provider: "provider" });
  let refreshes = 0;
  models.setProvider({ ...faux.provider, auth: { oauth: {
   name: "Test OAuth",
   login: async () => { throw new Error("Login not expected"); },
   refresh: async credential => {
    refreshes++;
    await Promise.resolve();
    return { ...credential, access: "access-refreshed", refresh: "rotated", expires: Date.now() + 3_600_000 };
   },
   toAuth: async credential => ({ apiKey: credential.access }),
  } } });
  const results = await Promise.all([models.getAuth("provider"), models.getAuth("provider"), models.getAuth("provider")]);
  expect(results.map(result => result?.auth.apiKey)).toEqual(["access-refreshed", "access-refreshed", "access-refreshed"]);
  expect(refreshes).toBe(1);
  expect(await store.read("provider")).toMatchObject({ access: "access-refreshed", refresh: "rotated" });
 });
 it("serializes the entire awaited refresh and deletion without publishing unfinished writes", async () => {
  const { store, secrets } = fixture(JSON.stringify({ provider: token }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const first = store.modify("provider", async current => {
   entered();
   await gate;
   expect(current).toEqual(token);
   return { ...token, access: "access-1", refresh: "refresh-1" };
  });
  await started;
  const second = store.modify("provider", async current => {
   expect(current).toMatchObject({ access: "access-1", refresh: "refresh-1" });
   return { ...token, access: "access-2", refresh: "refresh-2" };
  });
  const deletion = store.delete("provider");
  expect(JSON.parse(secrets.get("obsidiai-test")!)).toEqual({ provider: token });
  release();
  await Promise.all([first, second, deletion]);
  expect(await store.read("provider")).toBeUndefined();
  expect(JSON.parse(secrets.get("obsidiai-test")!)).toEqual({});
 });

 it("lists metadata only and isolates both reads and callback references", async () => {
  const { store } = fixture(JSON.stringify({ provider: token }));
  expect(await store.list()).toEqual([{ providerId: "provider", type: "oauth" }]);
  const read = await store.read("provider");
  if (read?.type !== "oauth") throw new Error("Missing credential");
  read.access = "modified";
  (read.account as { id: string }).id = "mutated";
  await store.modify("provider", async current => {
   if (current?.type === "oauth") current.refresh = "changed";
   return undefined;
  });
  expect(await store.read("provider")).toEqual(token);
 });

 it("surfaces persistence failure and preserves the last successfully persisted account", async () => {
  const { store, fail } = fixture(JSON.stringify({ provider: token }));
  fail();
  await expect(store.modify("provider", async () => ({ type: "api_key", key: "new-secret" }))).rejects.toThrow("Could not persist");
  expect(await store.read("provider")).toEqual(token);
  await expect(store.delete("provider")).rejects.toThrow("Could not persist");
  expect(await store.read("provider")).toEqual(token);
 });

 it("preserves existing credentials when an awaited operation is cancelled", async () => {
  const { store } = fixture(JSON.stringify({ provider: token }));
  const abort = new AbortController();
  await expect(store.modify("provider", async () => {
   abort.abort();
   return { type: "api_key", key: "not-committed" };
  }, { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(await store.read("provider")).toEqual(token);
 });

 it("requires explicit reset to recover malformed storage and resets only its own secret", async () => {
  const { store, secrets } = fixture('{"provider":{"type":"oauth","access":"secret"}}');
  expect(store.storageError).not.toBeNull();
  await expect(store.list()).rejects.toThrow("malformed");
  await expect(store.modify("provider", async () => ({ type: "api_key", key: "replacement" }))).rejects.toThrow("malformed");
  await store.reset();
  expect(await store.list()).toEqual([]);
  expect(secrets.get("obsidiai-test")).toBe("{}");
  expect(secrets.get("other-plugin")).toBe("untouched");
 });

 it("does not commit an awaited callback after disposal", async () => {
  const { store, secrets } = fixture(JSON.stringify({ provider: token }));
  await expect(store.modify("provider", async () => {
   store.dispose();
   return { type: "api_key", key: "not-persisted" };
  })).rejects.toThrow("disposed");
  expect(JSON.parse(secrets.get("obsidiai-test")!)).toEqual({ provider: token });
  await expect(store.read("provider")).rejects.toThrow("disposed");
 });
});
