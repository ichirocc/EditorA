# EditorA AI Assistant (standalone)

Chat with an AI model about a GitHub repository, review the edits it stages
as a diff, then push them to a work branch, open a pull request and merge it
into the base branch, each step only when you press its button.

It lives next to the Cordova-based editor in this repository and does not
depend on it. The editor's AI sidebar uses the same `core/`.

## Layout

| Path | Contents |
| --- | --- |
| `core/` | Provider-neutral logic: the tool loop for Claude (Anthropic SDK) and for OpenAI-compatible APIs, the repository tools, the GitHub client, the merge gate, the in-app three-way merge, and the session that ties them together. No dependency on a UI or platform. |
| `server/` | A Node.js HTTP server (no framework) that runs sessions, keeps the API keys and streams replies to the browser. |
| `web/` | The chat UI: plain HTML, CSS and JavaScript, no build step, laid out for phones. English or Japanese, following the browser. |
| `test/` | Vitest unit tests for all of the above. |

## Run it

Requires Node.js 20 or newer.

```sh
cd ai-assistant
npm install
npm start
```

The server prints a link such as `http://127.0.0.1:8787/#token=…`. Open it,
then use ⚙ to choose the AI provider and model and to enter the repository and
GitHub token. The browser keeps the access token; the server keeps the keys.

On an Android phone, run it in [Termux](https://termux.dev):

```sh
pkg install nodejs git
git clone https://github.com/ichirocc/EditorA
cd EditorA/ai-assistant && npm install && npm start
```

and open the printed link in the phone's browser.

### Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on. |
| `HOST` | `127.0.0.1` | Address to listen on. Only this device can connect by default. |
| `ASSISTANT_HOME` | `~/.editora-ai-assistant` | Where `config.json` (settings, keys, access token) is kept, readable only by you. |
| `ASSISTANT_TOKEN` | generated | Access token the browser must send. |
| `GITHUB_TOKEN` | | GitHub token, instead of entering it in the UI. |
| `ANTHROPIC_API_KEY`, `AI_KEY_<PROVIDER>` | | Provider keys, e.g. `AI_KEY_DEEPSEEK`, `AI_KEY_OPENAI`, instead of entering them in the UI. |

### AI providers

Anthropic Claude (default `claude-opus-5-5`), DeepSeek, OpenAI, Google Gemini,
xAI Grok, Moonshot Kimi, Alibaba Qwen, Z.ai GLM, Mistral, OpenRouter, or any
OpenAI-compatible API, including a model server on the same device at
`http://localhost`. Model names change often, so the settings dialog loads
the provider's current list (**Load models**); you can also type a name.

### GitHub token

A fine-grained personal access token limited to the repository, with
**Contents** and **Pull requests**: read and write, and **Checks**,
**Commit statuses** and **Actions**: read. Add **Workflows**: read and write
if the assistant should edit `.github/workflows`.

## How a change goes

1. Describe the change. The assistant reads the files it needs from GitHub
   and replies with a plan or stages edits. Nothing is sent to GitHub yet.
2. Review the staged edits as diffs; revert any file.
3. **Push** commits all staged edits as one commit on a new `ai/edit-…`
   branch (later pushes add commits to it). **Create PR** opens a pull
   request into the base branch.
4. CI results refresh while checks run. If CI fails, **Ask the assistant to
   fix** sends the failing checks, their annotations and the end of each
   GitHub Actions log to the chat.
5. If the pull request conflicts with or is behind the base branch,
   **Merge in main** merges the base branch into the work branch; the
   assistant resolves conflict markers on request, and you push the result
   as a merge commit (or cancel it).
6. **Merge** squash-merges after a confirmation, and only when there is no
   conflict, branch protection does not block it, every reported check
   passed, nothing is unpushed, and the head is the commit you reviewed.
   The server never merges on its own.

## Security

- The server listens on `127.0.0.1` and every API call needs the access
  token, because whoever can call it can push and merge. Before exposing it
  beyond the device (`HOST=0.0.0.0`), put it behind HTTPS.
- Keys are stored in `config.json` with mode `0600` and are never sent to the
  browser. Repository files the model reads, and CI failure details, go to
  the AI provider you chose, under that provider's terms.
- Model output is untrusted: tool paths are confined to the repository, edits
  only stage changes, and replies are HTML-escaped before rendering.

## Tests

```sh
npm test
```

The editor's CI runs the same tests from the repository root.

---

## クイックスタート（日本語）

GitHub のリポジトリについて AI とチャットし、AI がステージした変更を差分で確認してから、
ボタン操作でプッシュ → プルリクエスト作成 → ベースブランチへのマージまで行うアプリです。
エディタとは独立しており、エディタの AI サイドバーも同じ `core/` を使います。

1. Node.js 20 以上で `cd ai-assistant && npm install && npm start` を実行します
   （Android では Termux で `pkg install nodejs git` の後に同じ手順）。
2. 表示された `http://127.0.0.1:8787/#token=…` をブラウザで開きます。
3. ⚙ から AI プロバイダー（Claude、DeepSeek、OpenAI、Gemini など）を選び、API キーを入れて
   「モデル一覧を取得」からモデルを選びます。リポジトリと GitHub トークンも入力します。
4. 修正内容を指示 → 差分を確認 → **プッシュ** → **PRを作成** → CI が通ったら **マージ**。
   コンフリクト時は「main を取り込む」、CI 失敗時は「AIに修正を依頼」が使えます。

API キーはサーバー側の `~/.editora-ai-assistant/config.json`（本人のみ読み取り可）に保存され、
ブラウザには送られません。既定では同じ端末からしか接続できません。
