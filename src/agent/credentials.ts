import type { App } from "obsidian";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

const storageMessage = "Plugin credential storage is unavailable or malformed. Reset plugin credentials in ObsidiAI settings to recover.";
function validCredential(value: unknown): value is Credential {
 if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
 const credential = value as Partial<Credential>;
 if (credential.type === "api_key") return (credential.key === undefined || typeof credential.key === "string") &&
  (credential.env === undefined || (credential.env !== null && typeof credential.env === "object" && !Array.isArray(credential.env) && Object.values(credential.env).every(v => typeof v === "string")));
 return credential.type === "oauth" && typeof credential.access === "string" && typeof credential.refresh === "string" && typeof credential.expires === "number" && Number.isFinite(credential.expires);
}
function copy<T>(value: T): T { return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T; }

/** One plugin-owned secret; no ambient credential enumeration or external auth-file access. */
export class ObsidianCredentialStore implements CredentialStore {
 private entries = new Map<string, Credential>();
 private queue: Promise<unknown> = Promise.resolve();
 private disposed = false;
 private error: string | null = null;
 get storageError(): string | null { return this.error; }
 constructor(private readonly app: App, private readonly secretId: string) {
  try {
   const raw = app.secretStorage.getSecret(secretId);
   if (raw === null) return;
   const parsed: unknown = JSON.parse(raw);
   if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !Object.entries(parsed).every(([key, value]) => key.length > 0 && validCredential(value))) throw new Error(storageMessage);
   this.entries = new Map(Object.entries(parsed) as [string, Credential][]);
  } catch { this.error = storageMessage; }
 }
 private check(options?: AuthOperationOptions, allowBroken = false): void {
  if (this.disposed) throw new Error("Credential storage has been disposed.");
  options?.signal?.throwIfAborted();
  if (!allowBroken && this.error) throw new Error(this.error);
 }
 private serialize<T>(fn: () => Promise<T>): Promise<T> {
  const result = this.queue.then(fn);
  this.queue = result.then(() => undefined, () => undefined);
  return result;
 }
 async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
  await this.queue;
  this.check(options);
  return copy(this.entries.get(providerId));
 }
 async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
  await this.queue;
  this.check(options);
  return [...this.entries].sort(([a], [b]) => a.localeCompare(b)).map(([providerId, value]) => ({ providerId, type: value.type }));
 }
 modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
  return this.serialize(async () => {
   this.check(options);
   if (!providerId) throw new Error("A provider ID is required.");
   const proposed = await fn(copy(this.entries.get(providerId)));
   this.check(options);
   if (proposed !== undefined) {
    if (!validCredential(proposed)) throw new Error("Invalid provider credential.");
    const next = new Map(this.entries);
    next.set(providerId, copy(proposed));
    await this.persist(next);
   }
   return copy(this.entries.get(providerId));
  });
 }
 delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
  return this.serialize(async () => {
   this.check(options);
   const next = new Map(this.entries);
   next.delete(providerId);
   await this.persist(next);
  });
 }
 reset(options?: AuthOperationOptions): Promise<void> {
  return this.serialize(async () => {
   this.check(options, true);
   await this.persist(new Map());
   this.error = null;
  });
 }
 private async persist(next: Map<string, Credential>): Promise<void> {
  try { await this.app.secretStorage.setSecret(this.secretId, JSON.stringify(Object.fromEntries(next))); }
  catch { throw new Error("Could not persist plugin credentials. The previous credential remains unchanged."); }
  if (!this.disposed) this.entries = next;
 }
 dispose(): void { this.disposed = true; this.entries.clear(); }
}
