# Repository Guidelines

## Project Overview

ObsidiAI is a desktop-only Obsidian plugin providing a native workspace AI-agent tab powered by pi. It runs in-process, not through a terminal, subprocess, or iframe. Its 18 tools cover the visible file tree, Markdown notes, native metadata/graph queries, instruction-only skills, and approval-bound community-plugin lifecycle and settings management.

## Architecture & Data Flow

- `src/main.ts` is the composition/lifecycle root. It persists settings, checks embedded Node compatibility **before dynamically importing the agent runtime**, constructs services, and registers the native view, commands, and settings.
- `src/agent/runtime.ts` is the single provider factory: pi's built-in model catalog, static OAuth/Bedrock registration, and SSE transport. `credentials.ts` serializes credential mutations into one plugin-owned Obsidian SecretStorage entry.
- `src/agent/controller.ts` coordinates one real pi `Agent` and sequential tools. Draft attachments/selected skills become untrusted user context on Send; agent events become timeline items in `src/ui/agent-view.ts`. Run states are `idle`, `running`, `awaiting-approval`, and `stopping`.
- User timeline text is the original submitted draft. Typed attachments live in `src/agent/attachments.ts`: note/text bodies and real pi image blocks belong only in model messages; `attachmentReferences` indexes those user-message blocks for snapshot previews without duplicating payloads in history. Keep legacy `attachmentPaths` history readable. Only note attachments supply Markdown source paths. Reject text-only models for image-containing draft or historical context before consuming drafts.
- `src/ui/attachment-input.ts` is shared by computer-file selection, clipboard files, and native drag/drop. Check raster signatures, UTF-8 validity and bounds; never execute content or persist computer directory paths. Recognized source extensions can override incorrect platform MIME labels, but not byte validation. Large paste (4,000 characters or 40 lines) becomes an in-memory text attachment. Preview via `attachment-preview.ts` as safe raw text or raster images; no vault or OS temporary-file writes. Guard late file reads with the view attachment epoch and preserve unsent inputs on failures. Limits: 200k text characters, 5 MiB/image, 20 attachments and 20 MiB total per message.
- Modifier-click handling is capture-scoped to the chat timeline: Ctrl/Cmd-click internal links and note embeds calls native `openLinkText` with `"tab"` and the message source path, preventing duplicate native handling. Ordinary rendered-link behavior remains native.
- `src/vault/open-notes.ts` inspects open Markdown leaves only. The persisted `autoAttachOpenNotes` preference defaults off; the composer previews paths and captures allowed current editor/disk snapshots on Send. Manual attachments take precedence, per-message exclusions reset after submission, and automatic snapshots must not remain as stale draft attachments after preparation fails.
- Tool-only assistant messages do not split a collapsible tool chain. Keep per-call results and pending approval cards independently accessible; collapsed chains must never hide approval controls.
- Thinking effort uses pi's `getSupportedThinkingLevels` and `clampThinkingLevel`. Settings persist the preferred level; the controller exposes the effective level for the selected model and applies it to the existing Agent without resetting the conversation.
- Note/plugin services request decisions from the shared `ApprovalController` in `src/ui/approval.ts`. Its session-only `PermissionMode` is `ask` by default, `read-only` rejects mutations but allows reviewed settings disclosure, and `auto-approve-notes` bypasses only note approvals. Controller guards changes while running and resets mode for new conversations. `current` exposes one pending proposal; `decide(id, decision)` ignores stale IDs, and its lifetime signal disables settled controls and disclosure callbacks. `renderApprovalCard` displays safe text diffs, unchecked local settings fields, and plugin warnings inline. Stop and last-view closure cancel pending decisions; this is not rollback after mutation starts.
- Preferences alone go through serialized `saveSettings()`. `HistoryStore` serializes settled Agent messages and timeline to plugin-local `history.json`; summaries omit payloads, and reopen restores context using the current selected model. ObsidiAI provider credentials never belong in history, `data.json`, tool results, or logs. Other plugins' explicitly selected JSON values are disclosed to the provider and persisted in history; unselected settings must stay local. Unsent drafts and permission modes remain in memory. Provider errors are reduced to fixed safe status messages before display/persistence.
- `src/ui/history-view.ts` is a lifecycle-owned screen inside `AgentView`, not a modal or a separate persistence layer. Search summaries only, group dates locally, and bound rendered rows while searching the full list. Multi-selection survives filters; Select all results covers all matches, not just rendered rows. Snapshot IDs for explicit inline confirmation, show the off-filter selection count, and lock changes while saving. `deleteConversations(ids)` uses one queued history write for the batch; publish removals and reset an included active chat only after success. Preserve the selection on failure. Guard operations with busy/idle state and discard late reads after navigation or disposal. Returning to chat without selecting another conversation preserves the draft.
- Provider login management is separate from active chat selection: one saved credential per provider, with shared `runConnectionOperation` serialization for authentication/model/effort changes. Pi spreads `AuthInteraction`; keep `AuthModal.prompt` and `notify` as own, bound callbacks.
- `ComposerSuggest` owns textarea keyboard interaction for `@` notes/folders and `/` skill commands. Preserve IME, caret, async generation/attachment guards, and Enter-to-select before Send. `user-invocable: false` forbids explicit skill invocation; `disable-model-invocation: true` requires it.

## Key Directories

- `src/agent/`: provider transport, credentials, conversation orchestration, and tool services.
- `src/ui/`: native Obsidian views, authentication dialogs, and inline approval presentation.
- `src/vault/`, `src/skills/`, `src/plugins/`: shared path policy, vault-local skill discovery, and isolated native plugin-manager/release boundaries.
- `.github/workflows/`: shared CI and tag-triggered publication; `.github/release-notes/` holds reviewed per-version notes. `scripts/check-release.mjs` validates release metadata and built assets.
- `tests/`: behavioral suites; `tests/fixtures/knowledge.ts` shares metadata/graph host doubles. Other fixtures are mostly suite-local.
- `assets/`: shared notebook logo and native README screenshots. The SVG is imported as text and registered as `obsidiai-logo`, bundled into main.js so installation still needs only three files. Preview providers and sample conversations are not remote-provider verification.

## Development Commands

Run from the repository root:

```sh
npm ci                                    # Install the locked dependency graph
npm run typecheck                         # Strict source and test checking
npm run build                             # Typecheck, then production main.js
npm run check:release                     # Validate versions and built release assets
npm test                                  # Vitest, one complete run
npm test -- tests/vault-tools.test.ts      # Focused suite
npm run dev                               # Long-running esbuild watch
```

No lint/format script or configured formatter exists. Watch mode does not launch Obsidian. To run the plugin, install `main.js`, `manifest.json`, and `styles.css` under a disposable vault's `.obsidian/plugins/obsidiai/` and enable it there.

## Code Conventions & Common Patterns

- Use strict TypeScript, type-only imports for type dependencies, PascalCase classes, camelCase members, snake_case tool names, and `obsidiai-` CSS classes. Match adjacent formatting; existing quote/indent styles vary.
- Services receive `App`, approval controllers, catalogs, or lifecycle owners through constructors. Reuse these boundaries rather than adding alternate mutation paths or a second agent loop.
- Define tools with pi-ai's `Type` schemas and sequential execution. Successful results use `{ content: [{ type: "text", text: JSON.stringify(details) }], details }`; failures throw safe errors. Never expose upstream token-bearing response bodies.
- Preserve `AbortSignal` propagation, serialized settings/credential/plugin queues, idempotent prompt settlement, and lifecycle-owned event disposers. Whole-login cancellation and individual auth-prompt cancellation are distinct. Do not detach workspace leaves on plugin unload.
- Validate tool paths through `validateVaultPath`; add extension checks at the caller. Note edits require a current-run `read_note` snapshot and synchronous identity/content/open-editor checks inside `Vault.process`. Attachments do not authorize edits. Preserve size limits and collision checks.
- `list_files` traverses native folder children without reading bodies, bounded by depth/output/inspection limits. Continuation cursors are single-use, run-scoped, and capped; preserve explicit live-tree/depth/truncation caveats and cancellation. Hidden/config folders must not be traversed.
- Treat metadata as revision-checked native-cache snapshots, not guaranteed current truth. Keep explicit pagination, partial/truncation status, and deterministic graph traversal. Skills remain vault-local, run-scoped, and instruction-only; `allowed-tools` grants no permissions.
- Keep private `app.plugins` access inside the bridge. Distinguish installed, configured-enabled, and loaded states; fail unsupported capabilities explicitly. Never replace native lifecycle operations with filesystem deletion or direct writes to lifecycle configuration.
- `PluginSettingsService` shares the lifecycle queue and lifetime. Inspect only an installed other community plugin's existing canonical `data.json`; keep raw snapshots and opaque instance identities private. Disclosure creates a revision bound to copied selected paths; writes require separate exact-diff approval, disclosed existing leaves or absent keys under existing object parents, and exact-byte checks inside `DataAdapter.process`. Reject stale files, manifests, instances, unsafe pointers, and oversized JSON. Recheck after native unload and after restoration; never overwrite unload-time saves. Preserve enabled/session-only/disabled intent when safe, finish restoration after mutation even on Stop, and report actual persistence/partial state without leaking undisclosed values or claiming schema validation or rollback.

## Important Files

- `src/settings.ts`: non-secret settings schema and shared `renderProviderSettings` used by both settings surfaces.
- `src/vault/paths.ts`, `src/ui/approval.ts`: shared path and single-pending-approval contracts.
- `src/plugins/bridge.ts`, `src/plugins/registry.ts`: private-manager feature checks and official-registry/exact-release validation.
- `src/plugins/settings.ts`, `settings-data.ts`, `settings-types.ts`: selected-value disclosure receipts, bounded JSON patch policy, and approved native restart/restoration.
- `manifest.json`, `versions.json`, `tsconfig.json`, `esbuild.config.mjs`, `package.json`, `package-lock.json`: compatibility, compilation, bundling, and reproducible tooling. Root `main.js` is generated and ignored; never hand-edit it.

## Runtime/Tooling Preferences

Use **Node >=22.19.0 and npm**, not Bun as a substitute. Obsidian API >=1.11.4 and its installer's embedded Node version are separate requirements. Keep dependencies exact-pinned and update the npm lockfile with dependency changes.

TypeScript performs no emission; esbuild produces Node/CommonJS ES2022 output and lowers dynamic imports. Bundle application dependencies, leaving Obsidian/Electron, host CodeMirror/Lezer modules, and Node built-ins external. Preserve lazy undici initialization and lexical `fetch`/`globalThis.fetch` injection. The Undici-only build transform binds Node timers, performance, and web streams: renderer timers lack `.unref()`, DOM performance lacks `markResourceTiming`, and DOM streams can stall Node HTTP response bodies and cancellation. Do not mutate the host's fetch, timers, streams, performance, or shared dispatcher. Google/Bedrock deliberately omit the explicit custom-fetch option.

## Testing & QA

Vitest tests use narrow `vi.mock('obsidian', ...)` boundaries and in-memory fixtures. Follow `tests/vault-tools.test.ts` and `tests/agent-controller.test.ts` for real Agent loops with pi `fauxProvider`, `fauxAssistantMessage`, and `fauxToolCall`; no credentials or paid requests are needed.

Assert observable bytes, tool outcomes, cancellation settlement, credential consistency, cache completeness, and installed/enabled/loaded state. Drive approvals with promise gates/subscriptions rather than arbitrary sleeps. Cover stale state, rejection, abort, late clicks, and partial native failures when changing mutation policy.

Run the affected suite, then `npm run build`, `npm test`, and `npm run check:release`. GitHub Actions repeats checks on Node 22.19.0 and Node 24; release tags must exactly match the package/lockfile/manifest version without a `v` prefix. Update `versions.json` and `.github/release-notes/<version>.md` for each release. Keep third-party actions pinned to full commit SHAs and write permissions confined to publication. No coverage thresholds or checked-in native/packaged smoke runner exists. Mocked tests do **not** verify native UI, actual private-manager effects, or provider SDK packaging; separately exercise isolated bundles and a disposable Obsidian host and report unavailable host/account checks explicitly.
