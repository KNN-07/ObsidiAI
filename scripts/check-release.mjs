import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const [manifest, pkg, lock, versions] = await Promise.all(
  ["manifest.json", "package.json", "package-lock.json", "versions.json"].map(async path => JSON.parse(await readFile(path, "utf8")))
);
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
assert.equal(typeof manifest.version, "string", "manifest.version must be a string");
assert.match(manifest.version, stableVersion, "Use a stable x.y.z version without a v prefix");
assert.equal(pkg.version, manifest.version, "package.json and manifest.json versions must match");
assert.equal(lock.version, manifest.version, "Lockfile version must match manifest.json");
assert.equal(lock.packages?.[""]?.version, manifest.version, "Lockfile root package version must match manifest.json");
assert.equal(versions[manifest.version], manifest.minAppVersion, "versions.json must map this release to manifest.minAppVersion");
for (const [version, minimum] of Object.entries(versions)) {
  assert.match(version, stableVersion, "versions.json keys must be stable versions");
  assert.equal(typeof minimum, "string", "Minimum Obsidian versions must be strings");
  assert.match(minimum, stableVersion, "Minimum Obsidian versions must be stable versions");
}
if (process.env.RELEASE_TAG) {
  assert.equal(process.env.RELEASE_TAG, manifest.version, "Release tag must exactly match manifest.version (no v prefix)");
}
for (const path of ["main.js", "manifest.json", "styles.css"]) {
  const asset = await stat(path);
  assert(asset.isFile() && asset.size > 0, `Missing or empty release asset: ${path}`);
}
console.log(`Release ${manifest.version} validated: Obsidian >=${manifest.minAppVersion}; main.js, manifest.json, styles.css ready.`);
