# Acode - Code Editor for Android

<p align="center">
  <img src='res/logo_1.png' width='250'>
</p>

[![](https://img.shields.io/endpoint?logo=telegram&label=Acode&style=flat&url=https%3A%2F%2Facode.app%2Fapi%2Ftelegram-members-count)](https://t.me/foxdebug_acode) [![](https://dcbadge.limes.pink/api/server/https://discord.gg/vVxVWYUAWD?style=flat)](https://discord.gg/vVxVWYUAWD)

## • Overview

Welcome to Acode Editor - a powerful and versatile code editing tool designed specifically for Android devices. Whether you're working on HTML, CSS, JavaScript, or other programming languages, Acode empowers you to code on-the-go with confidence.

## • Features

- Edit and create websites, and instantly preview them in a browser.
- Seamlessly modify source files for various languages like Python, Java, JavaScript, and more.
- Built-in javascript console
- S/FTP and SSH terminal integration
- Built-in terminal(Alpine)
- Enjoy multi-language editing support with easy management tools.
- Enjoy a large collections of community plugins to enhance your coding experience.

## • Installation

You can get Acode Editor from popular platforms:

[<img src="https://play.google.com/intl/en_us/badges/images/generic/en-play-badge.png" alt="Get it on Google Play" height="60">](https://play.google.com/store/apps/details?id=com.foxdebug.acodefree) [<img src="https://fdroid.gitlab.io/artwork/badge/get-it-on.png" alt="Get it on F-Droid" height="60"/>](https://www.f-droid.org/packages/com.foxdebug.acode/)

## • Project Structure

<pre>
Acode/
|
|- src/   - Core code and language files
|
|- www/   - Public documents, compiled files, and HTML templates
|
|- utils/ - CLI tools for building, string manipulation, and more
|
|- codemirror-lsp-client/ - Git submodule providing @codemirror/lsp-client (clone with --recurse-submodules)
</pre>

## • AI assistant (chat → pull request → merge)

The **AI assistant** sidebar app (chat bubble icon) edits a GitHub repository through a chat with Claude and merges the result only when you say so.

1. Open the assistant's settings (gear icon) and enter the repository owner, name and base branch, an [Anthropic API key](https://platform.claude.com/), and a GitHub fine-grained personal access token limited to that repository with **Contents: read and write**, **Pull requests: read and write**, **Checks: read**, **Commit statuses: read** and **Actions: read** (for CI logs; add **Workflows: read and write** if the assistant should edit `.github/workflows`).
2. Describe the change. The assistant reads the files it needs (from GitHub, at the base branch) and replies with a plan or stages edits. Staged edits are listed with a diff and can be reverted per file; nothing is sent to GitHub yet.
3. **Push** commits all staged edits as one commit on a new `ai/edit-…` branch (later pushes add commits to the same branch). **Create PR** opens a pull request into the base branch.
4. CI results refresh on their own while checks run (**Check status** refreshes them at once). If CI fails, **Ask the assistant to fix** sends the failing checks, their annotations and the end of each GitHub Actions job log back to the chat.
5. If the pull request conflicts with the base branch or is behind it, **Merge in main** (the base branch) merges it into the work branch inside the app. Changes to different lines merge cleanly; lines both sides changed get conflict markers, which the assistant resolves on request (**Ask the assistant to resolve**). The result is reviewed like any other change and pushed as a merge commit; **Cancel merge** drops it.
6. **Merge** squash-merges only after a confirmation and only when the pull request has no conflicts, is not blocked by branch protection, every reported check has passed, and nobody else pushed to the branch. The app never merges on its own.

Requests go directly from the app to `api.anthropic.com` (model `claude-opus-5-5` by default) and `api.github.com`. The key and token are stored in Android encrypted shared preferences, not in the settings file or its backups.

## • Multi-language Support

Enhance Acode's capabilities by adding new languages easily. Just create a file with the language code (e.g., en-us for English) in [`src/lang/`](https://github.com/Acode-Foundation/Acode/tree/main/src/lang) and include it in [`src/lib/lang.js`](https://github.com/Acode-Foundation/Acode/blob/main/src/lib/lang.js). Manage strings across languages effortlessly using utility commands:

```shell
pnpm run lang add
pnpm run lang remove
pnpm run lang search
pnpm run lang update
```

## • Contributing & Building the Application

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed instructions.

## • Contributors

<a href="https://github.com/Acode-Foundation/Acode/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Acode-Foundation/Acode" />
</a>

## • Developing a Plugin for Acode

For comprehensive documentation on creating plugins for Acode Editor, visit the [repository](https://github.com/Acode-Foundation/acode-plugin).

For plugin development information, refer to: [Acode Plugin Documentation](https://docs.acode.app/)

## Star History

<a href="https://star-history.com/#Acode-Foundation/Acode&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Acode-Foundation/Acode&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Acode-Foundation/Acode&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Acode-Foundation/Acode&type=Date" />
 </picture>
</a>
