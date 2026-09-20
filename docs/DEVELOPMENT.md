# Developing ObsidiAI

[Back to ObsidiAI](../README.md) · [User guide](GUIDE.md)

## Requirements

Use **Node 22.19.0+ and npm**. The plugin targets **Obsidian desktop 1.11.4+**, with embedded Node **22.19.0+**. Updating the desktop installer may be necessary; an in-app update does not necessarily update Node.

## Build from source

If you want to develop or inspect a build yourself:

```sh
git clone https://github.com/KNN-07/ObsidiAI.git
cd ObsidiAI
npm ci
npm run build
```

Install `main.js`, `manifest.json`, and `styles.css` under a disposable vault’s `.obsidian/plugins/obsidiai/`, then enable ObsidiAI. Dependencies are bundled; do not copy `node_modules`. `main.js` is generated and not tracked in Git.

## Checks and local development

```sh
npm run typecheck                         # Check source and tests
npm test                                  # Run the behavioral suite
npm test -- tests/vault-tools.test.ts      # Run a focused suite
npm run build                             # Typecheck and bundle for production
npm run check:release                     # Validate versions and built release assets
npm run dev                               # Watch and rebuild; does not launch Obsidian
```

The implementation uses TypeScript, native Obsidian components, pi Agent/Models, esbuild, and Vitest. See [Repository Guidelines](../AGENTS.md) for architecture, code conventions, and safety invariants.

## Verification scope

Verification to date includes deterministic real-Agent tool loops, approval/conflict/cancellation cases, credential serialization, graph/metadata queries, skill restrictions, and plugin lifecycle policy. Isolated bundle checks have exercised incremental local SSE and cancellation through the real OpenAI-compatible and Google adapters, OAuth start/cancel, and host-fetch isolation.

Native settings verification on Obsidian 1.13.7 used a local scripted model and harmless fixture plugin: selected-only disclosure excluded an unselected token from model requests and history; approved JSON reached the restarted plugin; session-only and disabled states were preserved. Rejection, Stop/stale controls, read-only and auto-note permissions, stale files, unload-time saves, and disclosure limits were also exercised. Approval cards were checked in light and narrow dark layouts.

Native UI, permissions, quick context, and saved history have also been checked in Obsidian 1.13.7. A real NVIDIA request and cancellation were verified; successful OAuth login and native plugin installation/update/uninstallation remain unverified. Local scripted providers are not proof of remote account access.

Mocked tests and isolated bundles do **not** prove native UI behavior. Native fixture checks do not validate arbitrary third-party settings schemas, successful OAuth login, or native installation/update/uninstallation. Use disposable vaults and never include credentials or private note content in bug reports.

## CI and releases

GitHub Actions runs tests, typechecking, production builds, and release validation on pull requests and pushes to `main`, using **Node 22.19.0 and Node 24**. Successful runs retain the installable plugin artifact for seven days.

To prepare a release:

1. Keep `package.json`, `package-lock.json`, and `manifest.json` versions identical. Add the version-to-minimum-Obsidian mapping to `versions.json`.
2. Add reviewed notes at `.github/release-notes/<version>.md`.
3. Run `npm run build`, `npm test`, and `npm run check:release`. Commit and push the changes.
4. Push an annotated tag matching the manifest version exactly—such as `0.1.0`, **not** `v0.1.0`.

The Release workflow reruns the shared CI checks, downloads the tested artifact, and publishes both the three individual plugin assets and `obsidiai-<version>.zip` containing the ready-to-copy plugin folder. A draft is published only after asset upload succeeds. Published releases are not overwritten by the workflow; fix a failed draft by rerunning its workflow, or ship a new version for changes to an existing public release.

