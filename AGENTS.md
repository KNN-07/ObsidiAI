# Repository Guidelines

## Project Overview

ObsidiAI is a desktop-only Obsidian plugin embedding a pi-powered AI agent in a native workspace tab. It runs in-process, not through a terminal, subprocess, or iframe. Tools cover visible vault files, Markdown editing, native metadata/graph queries, instruction-only skills, and approval-bound community-plugin lifecycle/settings management.

## Architecture & Data Flow

- `src/main.ts` is the composition/lifecycle root. It checks the host's embedded Node version **before dynamically importing the agent runtime**, constructs shared services, and registers views, commands, and settings. Preserve this lazy runtime boundary.
- `src/agent/runtime.ts` is the provider factory: pi's built-in model catalog, OAuth/Bedrock registration, and SSE transport. `AgentController` receives the runtime and tool services through dependency injection and owns one real pi `Agent` with sequential tool execution.
- Send captures the draft, attachments, open-note snapshots, and selected skills as untrusted model context. Agent events become timeline items in `src/ui/agent-view.ts`. The controller owns `idle`, `running`, `awaiting-approval`, and `stopping`; connection/model/effort changes share serialized `runConnectionOperation` handling.
- `src/ui/approval.ts` owns one pending proposal. Session-only permissions default to `ask`; `read-only` rejects mutations but permits reviewed settings disclosure; `auto-approve-notes` bypasses only note approvals. Stale decisions are ignored. Stop/last-view closure cancels pending decisions, not already-started mutations. Collapsed tool chains must never hide approval controls.
- Keep persistence boundaries separate: preferences use queued `saveSettings()`; provider credentials use one plugin-owned Obsidian SecretStorage entry; `HistoryStore` queues settled messages/timeline into plugin-local `history.json`. Drafts and permission modes stay in memory. Publish persisted state only after writes succeed.
- Provider credentials must never enter settings JSON, history, tool results, or logs. Other plugins' explicitly selected settings may enter model context/history; unselected values stay local. Provider failures become fixed safe status messages, never upstream response bodies.
- `history-view.ts` is a screen owned by `AgentView`, not a separate store. Search summaries, bound rendered rows, retain selection across filters, and batch deletions into one queued write. Reset an included active chat only after successful persistence; navigation back to chat preserves its draft.

## Key Directories

- `src/agent/`: conversation orchestration, providers/credentials/history, and Agent-facing tool services.
- `src/ui/`: native views, composer/attachment handling, authentication, and approval presentation.
- `src/vault/`, `src/skills/`, `src/plugins/`: shared path/open-note policies, vault-local skill discovery, and isolated native plugin-manager/release/settings boundaries.
- `tests/`: behavioral suites and narrow host doubles; shared metadata/graph fixtures live in `tests/fixtures/knowledge.ts`.
- `docs/`: user behavior in `GUIDE.md`, contributor/release workflows in `DEVELOPMENT.md`.
- `scripts/`, `.github/workflows/`, `.github/release-notes/`: release validation, CI/publication, and reviewed per-version notes.
- `assets/`: documentation screenshots and SVG logo. The logo is bundled into `main.js`, not installed as a separate asset.

## Development Commands

Run from the repository root with Node and npm:

```sh
npm ci                                    # Install the locked dependency graph
npm run typecheck                         # Strict source and test checking; no emission
npm run build                             # Typecheck, then production main.js
npm test                                  # Vitest, one complete run
npm test -- tests/vault-tools.test.ts      # Focused behavioral suite
npm run check:release                     # Validate metadata and existing built assets
node --check main.js                      # CI's generated-bundle syntax check
npm run dev                               # Long-running esbuild watch
```

No lint/format script or configured formatter exists. There is no Obsidian launch script: watch mode only rebuilds. To exercise the plugin, install `main.js`, `manifest.json`, and `styles.css` under a disposable vault's `.obsidian/plugins/obsidiai/` and enable it in Obsidian.

## Code Conventions & Common Patterns

### Shared conventions

- Use strict TypeScript, type-only imports, PascalCase classes, camelCase members, snake_case tool names, and `obsidiai-` CSS classes. Match adjacent formatting; quote/indent styles vary.
- Inject `App`, catalogs, approval controllers, and lifecycle owners through constructors. Extend existing service boundaries rather than adding a second agent loop or UI-owned mutation path.
- Define tools with pi-ai's `Type` schemas. Structured results use `{ content: [{ type: "text", text: JSON.stringify(details) }], details }`; throw safe errors for failures and report explicit partial/conflict outcomes where mutation may already have occurred.
- Preserve `AbortSignal` propagation, serialized persistence/plugin queues, idempotent prompt settlement, and disposal/generation guards around async UI work. Release subscriptions/listeners on close; do not detach workspace leaves on plugin unload. Pi spreads `AuthInteraction`, so `AuthModal.prompt` and `notify` must remain own, bound callbacks.

### Vault, metadata, and skills

- Route vault-facing paths through `validateVaultPath`: visible vault-relative paths only; no traversal, hidden/config folders, absolute paths, or unsafe normalization. Apply caller-specific extension checks.
- Note edits require a current-run `read_note` snapshot and synchronous identity/content/open-editor revalidation inside `Vault.process`. Attachments do not authorize edits. Creation requires an existing visible parent and no target collision; preserve content bounds and exact-replacement checks.
- `list_files` traverses native children without reading bodies. Preserve bounded inspection/output, native ordering, run-scoped single-use cursors, cancellation, and explicit depth/truncation caveats.
- Metadata/graph output is a revision-checked native-cache snapshot, not guaranteed current filesystem truth. Preserve pagination, partial/unindexed status, and deterministic traversal.
- Skills are vault-local, run-scoped, untrusted instructions, never executable permissions. `allowed-tools` grants nothing; `user-invocable: false` forbids explicit invocation and `disable-model-invocation: true` requires it. Keep resource reads within the activated skill directory and revalidate captured snapshots.

### Attachments and native UI

- Keep original submitted text in the timeline; attachment bodies/images belong in model messages. `attachmentReferences` indexes those blocks without duplicating payloads; keep legacy `attachmentPaths` readable. Only note attachments provide Markdown source paths.
- File selection, clipboard, and drag/drop share `attachment-input.ts`. Validate UTF-8/raster signatures and bounds; MIME or recognized extensions never bypass byte checks. Retain basenames, not computer directory paths; previews are in-memory raw text/raster images, without temporary files. Limits: 200k text characters, 5 MiB/image, 20 attachments and 20 MiB total per message.
- Preserve draft inputs on failures, reject image-incompatible models before consuming drafts, and guard late reads with attachment epochs. Open-note auto-attachment defaults off; capture current editor/disk snapshots on Send, prefer manual attachments, and discard failed automatic snapshots.
- `ComposerSuggest` owns `@`/`/` keyboard selection: preserve IME, caret, async guards, and Enter-to-select before Send. Ctrl/Cmd-click interception is timeline-scoped and opens internal links/embeds with native `openLinkText(..., "tab", sourcePath)`; ordinary links retain native behavior.

### Community plugins and settings

- Keep private `app.plugins` access inside `src/plugins/bridge.ts`. Distinguish installed, configured-enabled, and loaded state; fail unsupported capabilities explicitly. Use native lifecycle operations, never filesystem deletion or direct lifecycle-config writes.
- Resolve official-registry/exact releases, obtain approval, then revalidate before mutation. Plugins are unsandboxed code. Once native mutation starts, cancellation is not rollback: finish safe restoration and report observed persistence/partial state.
- `PluginSettingsService` shares the lifecycle queue/lifetime and inspects only another installed plugin's existing canonical `data.json`. Keep raw bytes and instance identities private. Disclosure requires explicitly selected fields; edits require separate exact-diff approval and a revision bound to that disclosure.
- Preserve bounded JSON-pointer policy, disclosed existing leaves/absent keys under existing object parents, and exact-byte checks inside `DataAdapter.process`. Recheck manifests, instances, and bytes after unload/restoration; never overwrite unload-time saves. Preserve enabled/session-only/disabled intent when safe, without claiming schema validation or rollback.

## Important Files

- `src/main.ts`, `src/agent/controller.ts`: lifecycle composition and conversation state authority.
- `src/settings.ts`: non-secret settings and shared `renderProviderSettings` for both settings surfaces; persist preferred thinking effort and apply the model-supported effective level without resetting chat.
- `src/vault/paths.ts`, `src/ui/approval.ts`: shared path and approval contracts.
- `src/plugins/bridge.ts`, `registry.ts`, `settings.ts`, `settings-data.ts`, `settings-types.ts`: native capability checks, release validation, disclosure receipts, bounded patches, and restoration.
- `src/agent/node-fetch.ts`, `esbuild.config.mjs`: host-compatible transport and bundle transforms.
- `package.json`, `package-lock.json`, `tsconfig.json`: authoritative scripts, exact dependencies, strict source/test checking.
- `manifest.json`, `versions.json`, `scripts/check-release.mjs`: plugin compatibility and release consistency. Root `main.js` is generated/ignored; never hand-edit it.

## Runtime/Tooling Preferences

Use **Node >=22.19.0 and npm**, not Bun as a substitute. CI tests Node 22.19.0 and 24; no npm version is pinned. Obsidian API >=1.11.4 and its installer's embedded Node version are separate requirements. Keep dependencies exact-pinned and update the npm lockfile with dependency changes.

TypeScript does not emit; esbuild produces Node/CommonJS ES2022 output and lowers dynamic imports. Bundle application dependencies but leave Obsidian/Electron, host CodeMirror/Lezer modules, and Node built-ins external.

Preserve lazy Undici initialization and lexical `fetch`/`globalThis.fetch` injection. The Undici-only transform supplies Node timers, performance, and web streams because renderer globals are incompatible with Node HTTP streaming/cancellation. Do not mutate the host's fetch, timers, streams, performance, or shared dispatcher. Google/Bedrock intentionally omit the explicit custom-fetch option.

## Testing & QA

- Vitest uses narrow `vi.mock('obsidian', ...)` boundaries and fresh in-memory fixtures. Follow `tests/vault-tools.test.ts` and `tests/agent-controller.test.ts` for real Agent loops using pi's faux provider/messages/tool calls; no paid requests or credentials are needed. Reuse `tests/fixtures/knowledge.ts` for metadata/graph behavior.
- Assert observable bytes, tool outcomes, cancellation settlement, credential consistency, cache completeness, and installed/enabled/loaded state. Use promise gates/subscriptions or observable-state waits, not arbitrary sleeps. Mutation changes need rejection, stale-state, abort, late-click, and partial-failure cases; settle pending work and dispose fixtures.
- For code changes, run the affected suite, then `npm run build`, `npm test`, and `npm run check:release`. No coverage threshold is configured. `tests/node-fetch.test.mjs` additionally exercises a built transport module with browser-like VM globals and a real localhost HTTP stream.
- Mocks and VM checks do **not** verify native UI, actual private-manager effects, real OAuth/providers, or complete provider SDK packaging. Exercise changed host boundaries in a disposable Obsidian installation and isolated bundles as appropriate; report unavailable host/account checks explicitly.
- Releases must align package/lockfile/manifest versions, `versions.json`, and `.github/release-notes/<version>.md`; tags are exact numeric versions without a `v` prefix. CI validates built assets; publication packages the tested Node 24 artifact (`main.js`, `manifest.json`, `styles.css`) rather than rebuilding. Keep third-party actions SHA-pinned and write permissions confined to publication. See `docs/DEVELOPMENT.md` for the release procedure; use metadata rather than hard-coded README ZIP examples as version authority.
