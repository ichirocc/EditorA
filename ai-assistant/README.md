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

### From a release package

The **EditorA AI Assistant** pre-releases on GitHub carry
`editora-ai-assistant-<version>.zip`, with the dependencies included, so it
needs only Node.js 20 or newer (no npm):

```sh
unzip editora-ai-assistant-<version>.zip
cd editora-ai-assistant-<version>
node server/server.js
```

The repository's three builds are named apart: `editora-acode-*.apk` (the
Acode-based editor with the AI sidebar), `editora-native-*.apk` (the native
editor) and `editora-ai-assistant-*.zip` (this assistant on its own).

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

- **AI companies**: Google Gemini (the default, model
  `gemini-flash-latest`), Anthropic Claude (`claude-opus-5-5`), DeepSeek,
  OpenAI, xAI Grok, Moonshot Kimi, Alibaba Qwen, Z.ai GLM, Mistral.
- **Open models, hosted**: OpenRouter, Hugging Face, Groq, Together AI,
  Fireworks AI. They run open-weight models such as Llama, Qwen, gpt-oss,
  DeepSeek, Kimi and GLM.
- **Open models on this device**, no API key: Ollama, LM Studio, llama.cpp.
- **Custom**: any other OpenAI-compatible API.

Gemini is the default because it has a free tier: create an API key at
no cost in [Google AI Studio](https://aistudio.google.com/apikey). The free
tier has daily limits, and Google may use what is sent on it (including the
repository files the assistant reads) to improve its products; use a paid
key, or a model on this device, for code that must stay private.

Model names change often, so the settings dialog loads the provider's
current list (**Load models**); you can also type a name. The assistant
edits files through tool calls, so pick a model that supports them (Hugging
Face's list only shows such models).

#### Open models on this device

Start the model server, then choose it in ⚙ and press **Load models**:

| Server | Start it | Notes |
| --- | --- | --- |
| [Ollama](https://ollama.com) | `ollama serve`, then `ollama pull <model>` (in Termux: `pkg install ollama`) | Pick a model tagged *tools* on ollama.com. Ollama's default context of 4096 tokens is too small for the assistant's instructions and files; start it with `OLLAMA_CONTEXT_LENGTH=32768 ollama serve`. |
| [LM Studio](https://lmstudio.ai) | Developer tab → start the server, or `lms server start` | |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | `llama-server -m model.gguf --jinja -c 32768` | `--jinja` turns on tool calling. |

The default addresses are `http://localhost:11434/v1`, `http://localhost:1234/v1`
and `http://localhost:8080/v1`; change the API base URL if yours differs.
Only `http://localhost` and `http://127.0.0.1` are allowed without HTTPS.
Small models often fail to follow the tool instructions; larger ones (tens of
billions of parameters) work much better.

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

Instead of the buttons, you can ask in the chat: "push it", "open a pull
request", "merge it". The assistant then takes that step with its GitHub
tools (`push_changes`, `open_pull_request`, `get_pull_request_status`,
`merge_pull_request`), only when your latest message asks for it, and the
app shows each push, pull request and merge for you to approve or decline
first. A merge from the chat goes through the same checks as the button.

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

### Check the AI providers with real API calls

```sh
AI_KEY_DEEPSEEK=… AI_KEY_GEMINI=… AI_MODEL_GEMINI=… npm run check:providers
```

For each provider whose key is set (same variable names as above), this
loads the model list and runs two real turns on a one-file in-memory
repository: the model must edit the file with its tools, then make a
follow-up edit, which checks that the provider accepts the earlier tool
calls and results. Nothing is sent to GitHub. Providers without a default
model need `AI_MODEL_<PROVIDER>`; the output lists the available models.
`--only deepseek,gemini` limits the run and `--json` prints the results as
JSON. Each provider checked costs a few cents of API usage.

---

## クイックスタート（日本語）

GitHub のリポジトリについて AI とチャットし、AI がステージした変更を差分で確認してから、
ボタン操作でプッシュ → プルリクエスト作成 → ベースブランチへのマージまで行うアプリです。
エディタとは独立しており、エディタの AI サイドバーも同じ `core/` を使います。

1. Node.js 20 以上で `cd ai-assistant && npm install && npm start` を実行します
   （Android では Termux で `pkg install nodejs git` の後に同じ手順）。
   GitHub のプレリリース「EditorA AI Assistant」の `editora-ai-assistant-<バージョン>.zip` を使う場合は、
   展開したフォルダで `node server/server.js` を実行するだけです（依存パッケージ同梱のため npm は不要）。
2. 表示された `http://127.0.0.1:8787/#token=…` をブラウザで開きます。
3. ⚙ から AI プロバイダー（Claude、DeepSeek、OpenAI、Gemini など）を選び、API キーを入れて
   「モデル一覧を取得」からモデルを選びます。リポジトリと GitHub トークンも入力します。
   既定は無料枠のある Google Gemini（モデル `gemini-flash-latest`）で、API キーは
   [Google AI Studio](https://aistudio.google.com/apikey) で無料で作れます。無料枠には 1 日の上限があり、
   送った内容（AI が読んだファイルを含む）が Google の製品改善に使われることがあります。
   公開したくないコードには、有料のキーか端末上のモデルを使ってください。
   オープンモデル（Llama、Qwen、gpt-oss など）は Hugging Face・Groq・Together AI・Fireworks AI・
   OpenRouter で使えるほか、Ollama・LM Studio・llama.cpp で端末上に動かせば API キーなしで使えます
   （Ollama は `OLLAMA_CONTEXT_LENGTH=32768 ollama serve` で起動し、ツール対応のモデルを選んでください）。
4. 修正内容を指示 → 差分を確認 → **プッシュ** → **PRを作成** → CI が通ったら **マージ**。
   コンフリクト時は「main を取り込む」、CI 失敗時は「AIに修正を依頼」が使えます。
   ボタンの代わりにチャットで「プッシュして」「PR を作って」「マージして」と頼むこともできます。
   AI が実行する前に、プッシュ・PR 作成・マージのそれぞれで確認画面が出ます。マージはボタンと同じ条件
   （CI 成功・コンフリクトなし）を満たすときだけ行われます。

各社の AI が実際に使えるかは、API キーを環境変数に設定して `npm run check:providers` で確認できます
（例: `AI_KEY_DEEPSEEK=… npm run check:providers -- --only deepseek`）。モデル一覧の取得と、
ツールでのファイル編集・続けての再編集を実際の API で行います。GitHub には何も送りません。

API キーはサーバー側の `~/.editora-ai-assistant/config.json`（本人のみ読み取り可）に保存され、
ブラウザには送られません。既定では同じ端末からしか接続できません。
