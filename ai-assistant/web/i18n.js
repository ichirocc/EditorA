const STRINGS = {
	en: {
		title: "AI assistant",
		newSession: "New session",
		settings: "Settings",
		placeholder: "Describe the change…",
		intro: "Working on {repo} from {branch}. Describe the change you want.",
		setupRequired:
			"Open settings to choose an AI provider and model, and enter the repository and GitHub token.",
		tokenPrompt:
			"Enter the access token printed when the server started (the part after #token=).",
		token: "Access token",
		changes: "Changes ({count})",
		revertConfirm: "Revert the changes to {path}?",
		push: "Push",
		createPr: "Create PR",
		checkStatus: "Check status",
		merge: "Merge",
		openPr: "Open on GitHub",
		commitMessage: "Commit message",
		prTitle: "Pull request title",
		mergeConfirm: "Squash-merge pull request #{number} into {branch}?",
		mergeBlocked: "Cannot merge yet:",
		ciSummary: "CI: {passed} passed, {pending} running, {failed} failed",
		ciPassed: "All CI checks passed.",
		fixCi: "Ask the assistant to fix",
		fixCiMessage:
			"CI failed on the pull request: {names}. Find the cause and fix it.",
		syncBase: "Merge in {branch}",
		mergingBase:
			"Merging the latest {branch} into this branch. Review the changes and push to finish.",
		conflicts: "Conflicts to resolve: {paths}",
		resolveConflicts: "Ask the assistant to resolve",
		resolveConflictsMessage:
			"Merging {branch} left conflicts in: {paths}. Resolve them so that both sides' changes are kept where possible and no conflict markers remain.",
		abortMerge: "Cancel merge",
		discardConfirm:
			"Discard this conversation and any changes that were not merged?",
		"note.pushed": "Pushed {sha} to {branch}.",
		"note.pr opened": "Opened pull request #{number}.",
		"note.merged": "Merged pull request #{number} into {branch}.",
		"note.up to date": "The branch already has the latest {branch}.",
		"note.merging base": "Merged the latest {branch} in. Conflicts: {paths}",
		"note.merging base clean":
			"Merged the latest {branch} in without conflicts. Review the changes and push.",
		"note.merge aborted": "Cancelled merging {branch}.",
		"note.stopped": "Stopped.",
		"note.refusal": "The model declined this request.",
		"note.truncated": "The reply was cut off. Ask the assistant to continue.",
		"blocker.merged": "The pull request is already merged.",
		"blocker.closed": "The pull request is closed.",
		"blocker.draft": "The pull request is a draft.",
		"blocker.computing":
			"GitHub is still checking whether it can be merged. Check again shortly.",
		"blocker.conflict": "The branch conflicts with {branch}.",
		"blocker.protected":
			"Branch protection blocks the merge (required reviews or checks).",
		"blocker.behind":
			"The branch is behind {branch} and must be updated first.",
		"blocker.ci failed": "CI failed: {names}",
		"blocker.ci running": "CI is still running: {names}",
		"blocker.ci starting": "Waiting for CI to start…",
		"blocker.head changed":
			"The branch has commits that were not pushed from this session. Review the pull request on GitHub.",
		"blocker.unpushed": "Push the staged changes first.",
		"warning.no checks":
			"No CI checks were reported for this commit. If the repository has CI, it may not have started yet.",
		provider: "AI provider",
		providerCustom: "Custom (OpenAI-compatible API)",
		apiKey: "API key",
		keySaved: "Saved (enter only to replace it)",
		baseUrl: "API base URL",
		model: "Model",
		loadModels: "Load models",
		modelsLoaded: "{count} models",
		owner: "Repository owner",
		repo: "Repository name",
		branch: "Base branch",
		githubToken:
			"GitHub token (contents and pull requests: read and write; checks, statuses, actions: read)",
		save: "Save",
		cancel: "Cancel",
		ok: "OK",
		error: "Error",
	},
	ja: {
		title: "AIアシスタント",
		newSession: "新しいセッション",
		settings: "設定",
		placeholder: "修正内容を指示…",
		intro:
			"{repo} の {branch} ブランチを対象にしています。修正したい内容を入力してください。",
		setupRequired:
			"設定を開いてAIプロバイダーとモデルを選び、リポジトリとGitHubトークンを入力してください。",
		tokenPrompt:
			"サーバー起動時に表示されたアクセストークン（#token= の後ろ）を入力してください。",
		token: "アクセストークン",
		changes: "変更 ({count})",
		revertConfirm: "{path} の変更を元に戻しますか？",
		push: "プッシュ",
		createPr: "PRを作成",
		checkStatus: "状態を確認",
		merge: "マージ",
		openPr: "GitHubで開く",
		commitMessage: "コミットメッセージ",
		prTitle: "プルリクエストのタイトル",
		mergeConfirm:
			"プルリクエスト #{number} を {branch} にスカッシュマージしますか？",
		mergeBlocked: "まだマージできません:",
		ciSummary: "CI: 成功 {passed}、実行中 {pending}、失敗 {failed}",
		ciPassed: "すべてのCIチェックが成功しました。",
		fixCi: "AIに修正を依頼",
		fixCiMessage:
			"プルリクエストのCIが失敗しました: {names}。原因を調べて修正してください。",
		syncBase: "{branch} を取り込む",
		mergingBase:
			"最新の {branch} をこのブランチに取り込み中です。変更を確認してプッシュすると完了します。",
		conflicts: "解消が必要なコンフリクト: {paths}",
		resolveConflicts: "AIに解消を依頼",
		resolveConflictsMessage:
			"{branch} の取り込みで次のファイルにコンフリクトが発生しました: {paths}。できるだけ両方の変更を活かして解消し、コンフリクトマーカーが残らないようにしてください。",
		abortMerge: "取り込みを中止",
		discardConfirm: "この会話と、マージされていない変更を破棄しますか？",
		"note.pushed": "{branch} に {sha} をプッシュしました。",
		"note.pr opened": "プルリクエスト #{number} を作成しました。",
		"note.merged": "プルリクエスト #{number} を {branch} にマージしました。",
		"note.up to date": "ブランチはすでに最新の {branch} を含んでいます。",
		"note.merging base":
			"最新の {branch} を取り込みました。コンフリクト: {paths}",
		"note.merging base clean":
			"最新の {branch} をコンフリクトなしで取り込みました。変更を確認してプッシュしてください。",
		"note.merge aborted": "{branch} の取り込みを中止しました。",
		"note.stopped": "停止しました。",
		"note.refusal": "モデルがこのリクエストを辞退しました。",
		"note.truncated": "応答が途中で切れました。続けるよう指示してください。",
		"blocker.merged": "このプルリクエストはマージ済みです。",
		"blocker.closed": "このプルリクエストはクローズされています。",
		"blocker.draft": "このプルリクエストはドラフトです。",
		"blocker.computing":
			"GitHub がマージ可否を確認中です。少し待ってから再確認してください。",
		"blocker.conflict": "ブランチが {branch} とコンフリクトしています。",
		"blocker.protected":
			"ブランチ保護ルールによりマージがブロックされています（必須のレビューまたはチェック）。",
		"blocker.behind": "ブランチが {branch} より古いため、先に更新が必要です。",
		"blocker.ci failed": "CIが失敗しました: {names}",
		"blocker.ci running": "CIが実行中です: {names}",
		"blocker.ci starting": "CIの開始を待っています…",
		"blocker.head changed":
			"このセッション以外からブランチにコミットが追加されています。GitHub でプルリクエストを確認してください。",
		"blocker.unpushed": "先にステージ中の変更をプッシュしてください。",
		"warning.no checks":
			"このコミットにはCIチェックが報告されていません。CIがある場合、まだ開始されていない可能性があります。",
		provider: "AIプロバイダー",
		providerCustom: "カスタム（OpenAI互換API）",
		apiKey: "APIキー",
		keySaved: "保存済み（変更する場合のみ入力）",
		baseUrl: "APIのベースURL",
		model: "モデル",
		loadModels: "モデル一覧を取得",
		modelsLoaded: "{count} 件のモデル",
		owner: "リポジトリの所有者",
		repo: "リポジトリ名",
		branch: "ベースブランチ",
		githubToken:
			"GitHubトークン（contents・pull requests の読み書き、checks・statuses・actions の読み取り）",
		save: "保存",
		cancel: "キャンセル",
		ok: "OK",
		error: "エラー",
	},
};

/** "ja" when the browser prefers Japanese, otherwise "en". */
export const LANG = (globalThis.navigator?.language || "")
	.toLowerCase()
	.startsWith("ja")
	? "ja"
	: "en";

/**
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 * @param {"en"|"ja"} [lang]
 * @returns {string}
 */
export function t(key, params = {}, lang = LANG) {
	let text = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
	for (const [name, value] of Object.entries(params)) {
		text = text.replaceAll(`{${name}}`, String(value));
	}
	return text;
}

/** For tests: every key must exist in every language. */
export const STRING_TABLES = STRINGS;
