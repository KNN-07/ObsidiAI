<p align="center">
  <img src="assets/obsidiai-logo.svg" alt="ObsidiAI — an open notebook with a copper sparkle" width="112" height="112">
</p>

<h1 align="center">ObsidiAI</h1>

<p align="center">
  <a href="https://github.com/KNN-07/ObsidiAI/actions/workflows/ci.yml"><img src="https://github.com/KNN-07/ObsidiAI/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/KNN-07/ObsidiAI/releases/latest"><img src="https://img.shields.io/github/v/release/KNN-07/ObsidiAI" alt="Latest release"></a>
</p>

<p align="center"><strong>Your vault. Your models. Your approval.</strong></p>

An AI agent in a native Obsidian tab. Ask questions across your notes, explore the connections between ideas, and turn a conversation into reviewed changes—without leaving your workspace.

Powered by [pi](https://github.com/earendil-works/pi), ObsidiAI runs inside the desktop plugin. No separate agent installation, terminal session, or embedded web app.

> **Early preview · Desktop only.** Behavioral tests and isolated bundle checks cover the implementation. The native UI, permissions, quick context, and saved history have been checked in a disposable vault on Obsidian 1.13.7. The source build's reviewed settings writes and restarts were also verified with a harmless local fixture plugin. A real NVIDIA request and cancellation were verified; successful OAuth login and native plugin installation/update/uninstallation remain unverified. Start in a disposable vault, not your only copy of important notes.

![Native ObsidiAI chat with the notebook logo, compact attached-file label, and completed Markdown response](assets/chat-light.png)

*Actual Obsidian 1.13.7, in a disposable vault with local scripted providers and sample conversation content. No private notes or credentials are shown. The chat screenshot shows 0.1.3; the provider-settings screenshot below was captured for 0.1.1 and predates the open-note context toggle.*

## From question to approved change

1. **Bring context.** Attach a note, capture an editor selection, enable **Open notes**, or ask the agent to find relevant notes. Nothing is sent until you send a message.
2. **Work with your vault.** The agent can inspect folders, search notes, inspect metadata, follow links, and load reusable skill instructions.
3. **Review the proposal.** In the default **Ask before changes** mode, note edits show a before/after diff directly in chat. Plugin changes also use inline approval cards, retaining code-execution and destructive-operation warnings.
4. **Decide what happens.** Approve or reject each change, use **Read-only**, or explicitly enable **Auto-approve notes** for this conversation. Note conflicts still require a fresh read; plugin changes always require individual approval.

Try prompts like:

> “Find notes tagged #project with status active and summarize the next steps.”
>
> “Which notes link to Projects/Alpha.md? Show the shortest link path to Research/Overview.md.”
>
> “Read Projects/Alpha.md and change Status: draft to Status: reviewed.”

## What you can do

| Capability | How it helps |
| --- | --- |
| **Chat in your workspace** | A centered conversation column, streaming responses, and a composer with note attachments, Skills, model selection and permissions. Subtle animations respect reduced-motion settings. |
| **Keep multiple providers connected** | Manage one saved login per provider in Settings. Add, reconnect, or disconnect each independently; search available models across providers directly from chat. |
| **Choose thinking effort** | Select only the levels supported by the current model. Your preference is saved; the effective level adapts when you switch models. Higher effort may use more tokens and time. |
| **Search and edit notes** | Browse the visible file tree—including empty folders—then search, read, edit, or create Markdown notes under the conversation's permission mode. |
| **Explore your knowledge graph** | Query backlinks, outlinks, neighborhoods, shortest paths, unresolved links, and orphan notes using Obsidian's native cache. |
| **Query structured information** | Filter by folder, exact tags, and frontmatter properties; inspect headings, tasks, links, and file metadata. |
| **Reuse skills** | Keep instruction-only skills in your vault and choose them from the Skills picker or with `/skill:name`. |
| **Manage community plugins** | Browse the official catalog and propose install, update, enable, disable, or uninstall operations—with separate approval for each change. |
| **Configure plugin settings** | Choose which saved JSON values to share, then separately review exact changes and any required plugin restart. |
| **Quickly include context** | Select or drop computer text/image files, paste images, and preview large pasted text as attachments. Use `@` for vault notes/folders, `/` for skills, or **Open notes** for current Markdown tabs. |
| **Resume and organize conversations** | Search saved chats in the integrated History screen, continue with your current model, or select several chats for confirmed bulk deletion. |
| **Inspect tool activity** | Expand or collapse tool-call chains and individual results. Pending approvals stay visible outside collapsed groups. |

Provider availability is not a promise of account access. Subscription eligibility, provider policy, credentials, and network conditions still apply. Graph and metadata results identify partial or provisional cache state rather than treating it as definitive vault truth.

NVIDIA can advertise models whose inference endpoint returns **HTTP 404** for the current account. This is different from an authentication failure; choose another model. A native request to `openai/gpt-oss-20b` succeeded during verification, while some other advertised models returned 404. **0.1.2** fixes a renderer/Node networking incompatibility that caused “Connection error” or stalled streams inside Obsidian.

### Conversation layout

The source build uses a Claude-inspired arrangement with restrained, shadcn-style controls, implemented entirely with native Obsidian components. No embedded web app or additional UI framework.

- **Start in the center.** Suggested prompts fill the draft without sending it. Provider setup remains visible until a model is ready.
- **Keep actions with the draft.** The paperclip, Skills picker, Open notes toggle, model selector, thinking-effort picker, permissions control, and Send/Stop controls sit inside the composer. Selected context appears as removable chips.
- **Read without clutter.** User messages align right; assistant responses use a readable column capped at 760px. Expand tool-call chains and individual calls for results and note links. Error details expand inside their chain; its summary flags failures. Pending approval cards remain outside collapsed chains, with note diffs in a darker padded inset and added/removed text in green/red.
- **Follow a live answer.** Incoming text gently fades into place while earlier text stays stable. The notebook logo and Thinking indicator pulse while streaming; completed Markdown has a brief transition. Reduced-motion preferences disable these effects.
- **Use any pane width.** The layout adapts to narrow split panes and Obsidian's light/dark themes. Enter sends; Shift+Enter adds a line. Scrolling upward pauses automatic following; **Jump to latest** resumes it.

**0.1.7** adds reviewed community-plugin settings tools: selectively share saved JSON values, approve exact changes, and preserve enabled/session-only/disabled state across required restarts. It retains computer text/image attachments, integrated History with bulk deletion, file-tree browsing, optional open-note context, collapsible tool chains, inline approvals, and native networking fixes. Download the installable ZIP from the [latest release](https://github.com/KNN-07/ObsidiAI/releases/latest).

## Get started

### Requirements

- **Obsidian desktop 1.11.4 or newer.** Mobile is not supported.
- **Embedded Node 22.19.0 or newer.** If ObsidiAI reports an older runtime, update the Obsidian desktop installer; an in-app update alone may not update Node.
- **Node 22.19.0+ and npm** on your development machine to build from source.
- A provider account/API key, or an ambient authentication method supported by your chosen provider, to send model requests.

### Install a release

Download **`obsidiai-<version>.zip`** from the [latest GitHub release](https://github.com/KNN-07/ObsidiAI/releases/latest). This is the ready-to-install plugin—not GitHub's automatic “Source code (zip)” archive. No local build or Node installation is needed; Obsidian's embedded Node requirement still applies.

Extract the ZIP into a **disposable test vault's** `.obsidian/plugins/` directory. It contains an `obsidiai` folder, giving you this layout:

```text
<test-vault>/.obsidian/plugins/obsidiai/
  main.js
  manifest.json
  styles.css
```

Alternatively, download the three individual assets—`main.js`, `manifest.json`, and `styles.css`—and put them in that folder. They remain available for Obsidian's plugin installer.

Application dependencies are bundled into `main.js`; do not copy `node_modules`.

Open the test vault in Obsidian, enable community plugins if needed, and enable **ObsidiAI**. You may need to reload Obsidian after copying the files.

### Build from source

If you want to develop or inspect a build yourself:

```sh
git clone https://github.com/KNN-07/ObsidiAI.git
cd ObsidiAI
npm ci
npm run build
```

Then install the three generated/root files using the same steps above. `main.js` is generated and not tracked in Git.

### Connect and start a conversation

1. Open **Settings → ObsidiAI**.
2. Under **Add / manage provider**, choose a provider and connect using one of its advertised authentication methods. Repeat for additional providers; each keeps its own login. Ambient-only providers show setup guidance instead of a login button.
3. Inspect **Saved provider logins** to manage or disconnect individual providers. Adding a login does not select a billable model or change the current chat selection.
4. Run **ObsidiAI: Open agent tab** from the command palette, or use the notebook ribbon icon.
5. Click the model control inside the composer and search across available providers and models. Use **Refresh models** in Settings when a dynamic catalog needs updating.
6. Use the brain-icon **thinking effort** control to choose a supported level. It is disabled when the model has no adjustable effort. Model, effort, and authentication changes are locked during an active run.
7. Write a prompt. Type **`@`** for notes/folders or **`/`** for skills; **Attach note** and **Skills** remain available as buttons.

You can also select text in an editor and run **ObsidiAI: Ask agent about selection**. This adds a draft attachment; it does not send anything automatically.

Switching providers preserves the conversation; your next request sends its context to the newly selected provider. This is a multi-provider list, not multiple accounts for the same provider. Reconnecting replaces only that provider's saved login. Disconnect removes its plugin-stored login, not ambient environment/profile credentials.

### Conversation permissions

The shield control in the composer offers:

- **Ask before changes** — default; review each note or plugin change.
- **Read-only** — inspect context without changing notes or plugins.
- **Auto-approve notes** — note edits and creation run without individual approval cards. Plugin lifecycle changes still require explicit approval.

Permission changes are locked during a run. New conversations reset to **Ask before changes**; elevated permissions are not saved. Automatic note approval does not bypass current-run reads, path restrictions, size limits, collision checks, or stale-content/open-editor checks. It does not grant shell or arbitrary filesystem access.

Pending changes appear **inside the conversation**, not in popup dialogs. Review the target and diff or plugin warnings, then choose **Approve** or **Reject**. Collapsing the tool chain does not hide the approval card. **Stop** or closing the last agent tab rejects pending approvals; stale buttons cannot approve a later proposal.

The read-only `list_files` tool lists visible folders and file paths, including empty folders, without reading note bodies. The agent is instructed to inspect actual destinations before proposing a new note and ask when your intended folder is ambiguous. Queries are depth-limited and paginated; hidden/configuration paths remain excluded, and creating missing folders is not supported.

### Quick context and skills

Type `@` in the composer and filter by a note or folder path, including spaces and nested paths. Use the arrow keys and Enter, or click a result. Selecting a folder attaches snapshots of permitted Markdown notes in that folder and its descendants; non-Markdown and restricted paths are excluded. Duplicate attachments are skipped, and unreadable, moved, or oversized notes are reported. The attachment status shows the result. Remove individual draft chips before sending if you do not want to include them.

After sending, your message shows the prompt plus compact file/skill labels, not the expanded context payload. The model still receives the attached snapshots, and saved model context still contains them; hiding the payload in the chat is a presentation change, not a privacy filter. Older saved transcripts retain their original display text and note links.

**Automatic open-note context:** enable **Open notes** in the composer or **Automatically attach open notes** in Settings. It is **off by default**, and the preference is saved. Dashed chips show the open Markdown tabs to be included; remove a chip to exclude that note for the next message. At Send, editable tabs contribute current unsaved text; reading/deferred tabs use their saved contents. Duplicate tabs are combined, and a manual attachment or editor selection takes precedence over automatic context for the same path. Hidden/configuration paths are excluded. Oversized notes (over 200,000 characters) or context that changes during preparation stop submission rather than being silently truncated.

Automatic context is captured anew for each message; exclusions reset after submission. Turning the option off stops new automatic attachments—it does not remove context already sent to a provider or saved in a conversation.

Type `/` at the start of a draft to choose a skill. Selection inserts `/skill:name `; add arguments and then send. It does not submit the prompt automatically. Escape dismisses suggestions; Shift+Enter inserts a newline.

### Computer files, images, and pasted text

Use **Attach files from computer** beside **Attach note** to select multiple files, or **drag and drop files onto the chat**. Supported inputs include UTF-8 text, Markdown, CSV/TSV, JSON/YAML/TOML, logs, common source/config files, and **PNG, JPEG, WebP, or GIF images**. Clipboard images can also be pasted directly into the composer. Binary documents and other text encodings are not converted.

Pastes of **4,000 characters or 40 lines** become a temporary `.txt` attachment instead of filling the composer. Short pastes remain normal text. Existing draft text outside the selected range is preserved. These attachments are in-memory snapshots, not new vault notes or files written into an operating-system temporary folder.

Click a draft or newly sent attachment chip to preview its full text or image; use the separate **×** button to remove a draft attachment. Text previews display raw content without executing HTML or rendering embedded resources. Sent previews remain available after reopening saved history. You can send attachments without an accompanying typed prompt.

**Limits:** 200,000 characters per text attachment, 5 MiB per image, at most 20 attachments and 20 MiB of total attachment data per message. Files are not silently truncated. Unsupported files and size-limit failures are reported; successfully attached files remain in the draft. Images are submitted as actual image inputs and require a model advertising image support. Switching an image-containing conversation to a text-only model blocks Send rather than silently dropping the images.

**Privacy:** nothing is uploaded merely by selecting, dropping, or pasting. Only the external filename—not its computer directory—is retained. On Send, attachment contents go to the selected provider and are stored in the plugin’s unencrypted chat history. An image preview does not imply that a remote vision provider has been verified.

**Output links:** Ctrl-click (Cmd-click on macOS) an internal note link or embedded note in an assistant response to open it in a **new tab**, preserving the chat tab. This also applies to generated tool-result note links; native source-relative links and heading references are retained.

### Saved conversations

The **History** button beside **New conversation** opens saved chats in an integrated screen inside the chat tab, matching its typography, spacing, and light/dark themes instead of opening a popup. Search titles, providers, or models; browse Today, Yesterday, Previous 7 days, and Earlier groups. Long lists show 50 conversations at a time with **Show more**; search covers all saved conversations.

Click a conversation—or press Enter in search to open its first result—to restore its transcript and model context. Future requests use your currently selected provider/model; permissions reset to **Ask before changes**. **Back to chat** or Escape returns without opening a different conversation and preserves your unsent draft. Conversations are saved after a response settles, including tool results and sent context. **New conversation** keeps the previous chat in history.

**Storage:** `.obsidian/plugins/obsidiai/history.json` by default (or your custom vault configuration folder). History is separate from credentials and settings, but it can contain sent note excerpts, attached text/images, skill instructions, and tool results. The plugin does not encrypt this file; vault sync and backups may copy it. Unsent draft attachments/skill selections and elevated permission modes are not stored. Saved provider credentials are not included.

Use a row’s trash button, then **Delete permanently** in its inline confirmation, to remove one saved chat. Or choose **Select chats**, check several conversations, and click **Delete selected**. **Select all results** includes every search match, even beyond the first 50 displayed rows. Selections survive filtering; the selected count identifies chats outside the current filter. **Clear selection** clears every selection; **Done** leaves selection mode.

Bulk deletion previews the selected titles and total before **Delete N permanently**. **Keep chats** or Escape cancels confirmation without losing the selection; another Escape leaves selection mode. Search Enter does not open a conversation while selecting. Selected removals are persisted together in one write, not a series of individual deletions. A failed write keeps the selection and shows an error for retry; the UI does not report success. Deleting the active chat resets it only after the save succeeds; deleting other chats leaves it intact. Copies already synced or backed up are outside deletion. Read failures have a retry action.

<details>
<summary>Saved provider logins in the native settings dialog</summary>

![Native dark-theme settings showing two independent provider logins and the active chat provider](assets/connections-dark.png)

*Local preview providers demonstrate the interface; this is not evidence of remote account access.*

</details>

## Make repeatable workflows with skills

Skills are Markdown instructions, not executable extensions. By default, ObsidiAI discovers them under the visible `Skills` folder:

```text
Skills/
  review/
    SKILL.md
    references/
      checklist.md
```

A minimal `SKILL.md`:

```markdown
---
name: link-review
description: Review a note's links and suggest useful connections.
---
Read the selected note, inspect its outgoing links and backlinks,
and suggest relevant connections. Explain proposed edits before
requesting approval. Use references/checklist.md when needed.
```

Choose **Skills** in the agent tab, run **ObsidiAI: Choose skill**, or begin a message with:

```text
/skill:link-review Focus on Projects/Alpha.md
```

Selecting a skill adds a removable draft chip. Skill resources are restricted to plain-text files inside the activated skill's directory. Set `disable-model-invocation: true` in frontmatter to require explicit user selection; these skills remain available in `/` suggestions. Set `user-invocable: false` to hide a model-only skill from the picker and slash suggestions and reject explicit `/skill:name` invocation. An `allowed-tools` declaration is descriptive only: it cannot grant execution permissions or bypass approvals.

## Privacy and control

- **Context goes to your selected provider.** After you send a prompt, the agent can read permitted notes, metadata, graph data, skills, and non-secret plugin manifests and include returned context in model requests. Attaching a note is not a limit on the other notes it may inspect during that run. Other plugins' settings are shared only through an explicit per-value review; approved values become model context and saved history.
- **No background vault uploads or embeddings.** There is no second persisted search index.
- **Conversation history is stored in the plugin folder.** Settled transcripts, sent context, and tool results are persisted to `history.json`, not plugin settings. Unsent drafts remain in memory. History can be reopened or deleted through the History screen; see the storage/sync warning above.
- **ObsidiAI provider credentials use Obsidian SecretStorage.** Non-secret preferences are saved separately. ObsidiAI does not automatically import pi CLI credentials from `~/.pi/agent/auth.json`; provider-supported ambient environment/profile authentication remains available. Other plugins may store secrets in their own JSON settings—do not select those values unless you intend to disclose them.
- **You control permissions.** Each new conversation defaults to individual approval; Read-only blocks mutations but allows explicitly reviewed settings disclosure. Auto-approve notes skips only note approval cards. Plugin lifecycle changes, settings disclosure, and settings writes always need their own approval. Note edits remain bound to a current-run snapshot and checked for conflicts with both saved notes and open editor buffers.
- **Stop is not undo.** It prevents pending approvals and subsequent work, but an atomic write or native plugin operation already in progress may finish. Applied changes stay applied.

### Community-plugin safety

Community plugins are **unsandboxed third-party code**. Native installation, updates, and enabling can execute code with Obsidian privileges. A registry listing is not a security audit, and ObsidiAI does not verify downloaded source code or checksums.

Plugin lifecycle management uses an isolated, private Obsidian API. Unsupported capabilities fail explicitly; there is no direct-filesystem or CLI fallback for lifecycle operations. New installations target a disabled state, and enabling requires a separate approval. Native uninstall may remove the plugin's files **and saved settings**; no backup is created.

ObsidiAI's approval policy constrains its own tools. It is not a sandbox against other plugins already running in Obsidian.

### Configure another plugin's settings

**Available in 0.1.7.** Ask for a setting change by plugin name or ID. Two tools handle the review:

1. **`inspect_plugin_settings`** opens a local review of saved JSON fields. Nothing is selected automatically. Only the values you select and approve are returned to the model and saved in chat history. You can continue with no values selected when proposing new keys.
2. **`propose_plugin_settings_change`** uses that review's revision to propose exact JSON-pointer changes. Existing values must have been disclosed; new keys require an existing object parent. Review the before/after diff and restart warning, then choose **Save settings** or **Reject**.

This supports only an installed community plugin's existing `<configDir>/plugins/<plugin-id>/data.json`. It cannot configure core plugins, ObsidiAI itself, or plugins that store settings elsewhere. Missing files must first be created by the target plugin. Arrays are edited as whole values, not individual indexes.

Reviews are bounded to a 256 KiB JSON object and 500 leaf fields; individual JSON values and paths are limited to 16,000 characters, selected-field payloads to 32,000 characters, and each proposal to 20 non-overlapping changes. Oversized values cannot be shared. Unselected data is preserved, though JSON formatting may change.

Changed data, plugin versions, or loaded instances invalidate the review. Writes compare the reviewed bytes inside Obsidian's atomic adapter operation. A loaded plugin is stopped and restarted only under the approved change; session-only loading stays session-only, and disabled plugins remain disabled. If stopping the plugin saves different settings, the patch is refused and prior runtime intent is restored when safe.

**Valid JSON is not a validated plugin configuration.** There is no universal settings schema or guarantee that a saved value takes effect. No backup or automatic rollback is provided. Once mutation starts, approved state restoration finishes even after Stop; failures report saved-data and observed plugin state and may leave partial changes.

## Development

```sh
npm run typecheck                         # Check source and tests
npm test                                  # Run the behavioral suite
npm test -- tests/vault-tools.test.ts      # Run a focused suite
npm run build                             # Typecheck and bundle for production
npm run check:release                     # Validate versions and built release assets
npm run dev                               # Watch and rebuild; does not launch Obsidian
```

The implementation uses TypeScript, native Obsidian components, pi Agent/Models, esbuild, and Vitest. See [Repository Guidelines](AGENTS.md) for architecture, code conventions, and safety invariants.

Verification to date includes deterministic real-Agent tool loops, approval/conflict/cancellation cases, credential serialization, graph/metadata queries, skill restrictions, and plugin lifecycle policy. Isolated bundle checks have exercised incremental local SSE and cancellation through the real OpenAI-compatible and Google adapters, OAuth start/cancel, and host-fetch isolation.

Native settings verification on Obsidian 1.13.7 used a local scripted model and harmless fixture plugin: selected-only disclosure excluded an unselected token from model requests and history; approved JSON reached the restarted plugin; session-only and disabled states were preserved. Rejection, Stop/stale controls, read-only and auto-note permissions, stale files, unload-time saves, and disclosure limits were also exercised. Approval cards were checked in light and narrow dark layouts.

Mocked tests and isolated bundles do **not** prove native UI behavior. Native fixture checks do not validate arbitrary third-party settings schemas, successful OAuth login, or native installation/update/uninstallation. Use disposable vaults and never include credentials or private note content in bug reports.

### CI and releases

GitHub Actions runs tests, typechecking, production builds, and release validation on pull requests and pushes to `main`, using **Node 22.19.0 and Node 24**. Successful runs retain the installable plugin artifact for seven days.

To prepare a release:

1. Keep `package.json`, `package-lock.json`, and `manifest.json` versions identical. Add the version-to-minimum-Obsidian mapping to `versions.json`.
2. Add reviewed notes at `.github/release-notes/<version>.md`.
3. Run `npm run build`, `npm test`, and `npm run check:release`. Commit and push the changes.
4. Push an annotated tag matching the manifest version exactly—such as `0.1.0`, **not** `v0.1.0`.

The Release workflow reruns the shared CI checks, downloads the tested artifact, and publishes both the three individual plugin assets and `obsidiai-<version>.zip` containing the ready-to-copy plugin folder. A draft is published only after asset upload succeeds. Published releases are not overwritten by the workflow; fix a failed draft by rerunning its workflow, or ship a new version for changes to an existing public release.

## Feedback

Found a problem or have a workflow in mind? [Open an issue](https://github.com/KNN-07/ObsidiAI/issues) with your Obsidian version, platform, steps to reproduce, and a sanitized example. For authentication issues, include the provider and safe error category—not tokens, keys, or raw response bodies.

## License

ObsidiAI is licensed under the [MIT License](LICENSE). Third-party dependencies retain their respective licenses.
