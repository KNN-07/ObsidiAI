import { requireApiVersion, type PluginManifest } from 'obsidian';
import { fetch as nodeFetch } from '../agent/node-fetch';
import { PluginPolicyError, validatePluginId, type PluginRelease } from './bridge';

export const COMMUNITY_REGISTRY_URL = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json';
export interface CommunityPlugin { id: string; name: string; author: string; description: string; repo: string }
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function compareVersions(a: string, b: string): number {
  if (!stable.test(a) || !stable.test(b)) throw new PluginPolicyError('Plugin version must be a stable x.y.z version');
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) { if (left[i]! > right[i]!) return 1; if (left[i]! < right[i]!) return -1; }
  return 0;
}
export function validateRepository(repo: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(repo) || repo.split('/').some(part => part.includes('..')) || repo.length > 250) throw new PluginPolicyError('Invalid community registry repository');
  return repo;
}
function parseManifest(raw: unknown, id: string): PluginManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PluginPolicyError('Invalid release manifest');
  const data = raw as Record<string, unknown>;
  for (const key of ['id', 'name', 'author', 'description', 'version', 'minAppVersion']) if (typeof data[key] !== 'string' || (key !== 'description' && !data[key])) throw new PluginPolicyError('Invalid release manifest fields');
  if (data.id !== id || !stable.test(String(data.version)) || !stable.test(String(data.minAppVersion)) || ('isDesktopOnly' in data && typeof data.isDesktopOnly !== 'boolean')) throw new PluginPolicyError('Invalid release manifest identity, version, or compatibility');
  return { id, name: String(data.name), author: String(data.author), description: String(data.description), version: String(data.version), minAppVersion: String(data.minAppVersion), ...(typeof data.isDesktopOnly === 'boolean' ? { isDesktopOnly: data.isDesktopOnly } : {}) };
}
export class PluginRegistry {
  private cache: { entries: CommunityPlugin[]; fetchedAt: string } | null = null;
  clear(): void { this.cache = null; }
  private async json(url: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    try {
      const response = await nodeFetch(url, { signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new PluginPolicyError(`Plugin metadata lookup failed (HTTP ${response.status}); check connectivity or GitHub rate limits.`);
      const reader = response.body?.getReader();
      if (!reader) throw new PluginPolicyError('Plugin metadata response has no body');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 10_000_000) throw new PluginPolicyError('Plugin metadata response is too large'); chunks.push(next.value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (signal.aborted) throw new PluginPolicyError('Plugin metadata lookup cancelled');
      if (error instanceof PluginPolicyError) throw error;
      throw new PluginPolicyError('Plugin metadata lookup failed; check connectivity and valid release metadata.');
    }
  }
  async list(signal: AbortSignal, fresh = false): Promise<{ entries: CommunityPlugin[]; fetchedAt: string }> {
    if (!fresh && this.cache) return structuredClone(this.cache);
    const raw = await this.json(COMMUNITY_REGISTRY_URL, signal);
    if (!Array.isArray(raw)) throw new PluginPolicyError('Invalid community registry metadata');
    const entries: CommunityPlugin[] = []; const ids = new Set<string>();
    for (const value of raw) {
      if (!value || typeof value !== 'object') throw new PluginPolicyError('Invalid community registry entry');
      const data = value as Record<string, unknown>;
      if (['id', 'name', 'author', 'description', 'repo'].some(key => typeof data[key] !== 'string')) throw new PluginPolicyError('Invalid community registry fields');
      const id = validatePluginId(String(data.id));
      if (ids.has(id)) throw new PluginPolicyError('Duplicate community registry ID');
      ids.add(id);
      entries.push({ id, name: String(data.name), author: String(data.author), description: String(data.description), repo: validateRepository(String(data.repo)) });
    }
    entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    this.cache = { entries, fetchedAt: new Date().toISOString() };
    return structuredClone(this.cache);
  }
  async resolve(id: string, signal: AbortSignal, fresh = true): Promise<PluginRelease> {
    validatePluginId(id);
    const entry = (await this.list(signal, fresh)).entries.find(item => item.id === id);
    if (!entry) throw new PluginPolicyError('Plugin is not in the official community registry; no release source is available.');
    const head = parseManifest(await this.json(`https://raw.githubusercontent.com/${entry.repo}/HEAD/manifest.json`, signal), id);
    let version = head.version;
    if (!requireApiVersion(head.minAppVersion)) {
      const raw = await this.json(`https://raw.githubusercontent.com/${entry.repo}/HEAD/versions.json`, signal);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PluginPolicyError('Invalid plugin versions metadata');
      const versions = Object.entries(raw).filter(([candidate, minimum]) => stable.test(candidate) && typeof minimum === 'string' && stable.test(minimum) && requireApiVersion(minimum) && compareVersions(candidate, head.version) <= 0).map(([candidate]) => candidate).sort((a, b) => compareVersions(b, a));
      if (!versions[0]) throw new PluginPolicyError('No compatible stable plugin release is available');
      version = versions[0];
    }
    const source = `https://github.com/${entry.repo}/releases/download/${version}/manifest.json`;
    const manifest = parseManifest(await this.json(source, signal), id);
    if (manifest.version !== version || !requireApiVersion(manifest.minAppVersion)) throw new PluginPolicyError('Exact release manifest version or host compatibility does not match');
    return { repo: entry.repo, manifest, targetVersion: version, olderCompatible: version !== head.version, source };
  }
}
