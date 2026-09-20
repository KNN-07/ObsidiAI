<p align="center">
  <img src="assets/obsidiai-logo.svg" alt="ObsidiAI" width="112" height="112">
</p>

<h1 align="center">ObsidiAI</h1>

<p align="center"><strong>Your vault. Your models. Your approval.</strong></p>

<p align="center">
  <a href="https://github.com/KNN-07/ObsidiAI/releases/latest">Download</a> ·
  <a href="docs/GUIDE.md">User guide</a> ·
  <a href="https://github.com/KNN-07/ObsidiAI/issues">Feedback</a>
</p>

<p align="center">
  <a href="https://github.com/KNN-07/ObsidiAI/releases/latest"><img src="https://img.shields.io/github/v/release/KNN-07/ObsidiAI" alt="Latest release"></a>
  <a href="https://github.com/KNN-07/ObsidiAI/actions/workflows/ci.yml"><img src="https://github.com/KNN-07/ObsidiAI/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

Ask questions across your notes, discover connections, and turn a conversation into reviewed changes—all in a native Obsidian tab. Powered by [pi](https://github.com/earendil-works/pi), with no separate agent installation or terminal window.

![ObsidiAI chat inside Obsidian](assets/chat-light.png)

*Native Obsidian with sample content. Screenshot from 0.1.3; the current release includes additional features.*

## What you can do

- **Find answers in your vault.** Search notes, tags, and properties; explore backlinks and paths between ideas.
- **Bring the right context.** Attach notes, text files, or images. Drag and drop, paste screenshots, or include your open notes.
- **Choose your models.** Keep multiple providers connected, switch models, and adjust supported thinking effort.
- **Make reviewed changes.** Create or edit notes, manage community plugins, and review exact plugin-setting changes before saving.
- **Reuse your workflows.** Apply Markdown skills with `/`, and add notes or folders with `@`.
- **Pick up where you left off.** Search saved conversations and resume them with your current model.

**New in 0.1.7:** configure other plugins through selective settings disclosure and separate change approval. [Release notes →](https://github.com/KNN-07/ObsidiAI/releases/tag/0.1.7)

## Get started

> **Desktop only · Early preview.** Try ObsidiAI in a disposable vault before using it with important notes.

1. Download **`obsidiai-0.1.7.zip`** from the [latest release](https://github.com/KNN-07/ObsidiAI/releases/latest)—not the automatic source-code ZIP.
2. Extract the `obsidiai` folder into `<vault>/.obsidian/plugins/`, then enable **ObsidiAI** in Obsidian’s Community plugins settings. Reload Obsidian if needed.
3. Open **Settings → ObsidiAI** and connect a provider using one of its available login methods.
4. Run **ObsidiAI: Open agent tab**, choose a model in the composer, and start a conversation.

Requires **Obsidian desktop 1.11.4+** with **embedded Node 22.19.0+**. If the runtime is too old, update the Obsidian desktop installer. No separate Node installation is needed to use the release. Provider account access and usage costs depend on your chosen provider.

**Updating?** Replace only `main.js`, `manifest.json`, and `styles.css`; preserve your existing `data.json` and `history.json`.

## Try asking

> “Find my active projects and summarize the next steps.”

> “How are Projects/Alpha.md and Research/Overview.md connected?”

> “Read Projects/Alpha.md and change Status: draft to Status: reviewed.”

> “Help me review and configure this community plugin’s settings.”

## You control the changes

**Ask before changes** is the default: review proposals directly in chat, then approve or reject them. Choose **Read-only** to prevent changes, or **Auto-approve notes** for note edits and creation within the current conversation. Plugin changes and settings disclosure always require separate approval.

Settings review starts with nothing selected. Only the values you approve are shared; saving changes requires another review. This supports existing community-plugin `data.json` files, not every plugin’s storage format or schema. [How settings review works →](docs/GUIDE.md#configure-another-plugins-settings)

**Stop is not undo.** Applied changes stay applied. Community plugins run unsandboxed code, and installing, enabling, or restarting them can execute that code. There is no automatic backup or rollback.

## Privacy, without surprises

- The agent can read permitted vault context—not just attachments—and send it to your selected provider. There are no background vault uploads or embeddings.
- Sent context, tool results, and approved settings values are saved in **unencrypted local chat history**. Vault sync and backups may copy it. Switching providers sends the conversation context to the newly selected provider.
- ObsidiAI’s provider credentials use **Obsidian SecretStorage**. Other plugins may keep secrets in their settings; share only values you intend to disclose.

See the [user guide](docs/GUIDE.md) for attachment limits, skills, history management, permissions, and provider setup.

---

[Development & contributing](docs/DEVELOPMENT.md) · [Report an issue](https://github.com/KNN-07/ObsidiAI/issues) · [MIT license](LICENSE)
