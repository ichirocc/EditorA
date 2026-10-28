import "./style.scss";
import autosize from "autosize";
import Sidebar from "components/sidebar";
import alert from "dialogs/alert";
import confirm from "dialogs/confirm";
import multiPrompt from "dialogs/multiPrompt";
import prompt from "dialogs/prompt";
import select from "dialogs/select";
import DOMPurify from "dompurify";
import { diffHunks, diffStat } from "lib/aiAssistant/diff";
import {
	createModelAdapter,
	getProvider,
	isAllowedBaseUrl,
	PROVIDERS,
	secretNameFor,
} from "lib/aiAssistant/providers";
import secrets from "lib/aiAssistant/secrets";
import appSettings from "lib/settings";
import markdownIt from "markdown-it";

const MAX_DIFF_LINES = 400;
const WATCH_FIRST_DELAY = 15_000;
const WATCH_MAX_DELAY = 60_000;
const WATCH_MAX_POLLS = 60;
const TOOL_ICONS = {
	list_files: "folder",
	read_file: "notes",
	edit_file: "edit",
	write_file: "edit",
	delete_file: "delete",
};

const markdown = markdownIt({ html: false, linkify: true, breaks: true });

/** @type {import("lib/aiAssistant/session").default|null} */
let session = null;
let busy = false;
/** @type {AbortController|null} */
let abortController = null;
/** @type {ReturnType<typeof setTimeout>|undefined} */
let watchTimer;
/** @type {Set<string>} paths whose diff is expanded */
const expanded = new Set();

/** @type {HTMLElement} */
let container;
const $subtitle = <div className="subtitle" />;
const $messages = (
	<div
		className="messages scroll"
		onclick={onMessageClick}
		onscroll={onMessagesScroll}
	/>
);
const $changes = <div className="changes" />;
const $actions = <div className="workflow" />;
const $input = (
	<textarea
		rows="1"
		placeholder={strings["ai input placeholder"]}
		onkeydown={onInputKeyDown}
	/>
);
const $sendIcon = <span className="icon send" />;
const $sendButton = (
	<button type="button" className="icon-button send" onclick={onSendClick}>
		{$sendIcon}
	</button>
);

const $header = (
	<div className="header">
		<div className="title">
			<span>{strings["ai assistant"]}</span>
			<div className="actions">
				<button
					type="button"
					className="icon-button"
					title={strings["ai new session"]}
					onclick={() => newSession()}
				>
					<span className="icon add" />
				</button>
				<button
					type="button"
					className="icon-button"
					title={strings["ai settings"]}
					onclick={openSettings}
				>
					<span className="icon settings" />
				</button>
			</div>
		</div>
		{$subtitle}
	</div>
);

export default [
	"chat_bubble", // icon
	"aiAssistant", // id
	strings["ai assistant"], // title
	initApp, // init function
	false, // prepend
	onSelected, // onSelected function
];

/**
 * @param {HTMLElement} el
 */
function initApp(el) {
	container = el;
	container.classList.add("ai-assistant");
	container.content = $header;
	container.append(
		$messages,
		$changes,
		$actions,
		<div className="composer">
			{$input}
			{$sendButton}
		</div>,
	);
	autosize($input);
	Sidebar.on("show", onSelected);
	showIntro();
	render();
}

function onMessagesScroll() {
	$messages.dataset.scrollTop = $messages.scrollTop;
}

function onSelected() {
	if ($messages.dataset.scrollTop) {
		$messages.scrollTop = $messages.dataset.scrollTop;
	}
}

function config() {
	return {
		provider: "anthropic",
		model: "claude-opus-5-5",
		baseUrl: "",
		owner: "",
		repo: "",
		baseBranch: "main",
		...appSettings.value.aiAssistant,
	};
}

/** @param {import("lib/aiAssistant/providers").Provider} provider */
function providerLabel(provider) {
	return provider.id === "custom"
		? strings["ai provider custom"]
		: provider.label;
}

function showSubtitle() {
	const { owner, repo, baseBranch, provider, model } = config();
	const target = owner && repo ? `${owner}/${repo} · ${baseBranch} · ` : "";
	$subtitle.textContent = `${target}${providerLabel(getProvider(provider))}: ${model}`;
}

function showIntro() {
	const { owner, repo, baseBranch } = config();
	showSubtitle();
	if (!owner || !repo) {
		note(strings["ai setup required"]);
		return;
	}
	note(
		strings["ai session started"]
			.replace("{repo}", `${owner}/${repo}`)
			.replace("{branch}", baseBranch),
	);
}

async function openSettings() {
	const choice = await choose(strings["ai settings"], [
		["model", strings["ai settings model"]],
		["repo", strings["ai settings repo"]],
	]);
	if (choice === "model") await openModelSettings();
	else if (choice === "repo") await openRepoSettings();
}

/**
 * select() that resolves null when cancelled.
 * @param {string} title
 * @param {[string, string][]} items
 * @param {string} [value] selected item
 * @returns {Promise<string|null>}
 */
function choose(title, items, value) {
	return new Promise((resolve) => {
		select(title, items, {
			default: value,
			onCancel: () => resolve(null),
		}).then(resolve, () => resolve(null));
	});
}

/**
 * @param {string} name
 * @param {boolean} saved
 */
function keepHint(name, saved) {
	return saved ? strings["leave empty to keep"].replace("{name}", name) : name;
}

async function openModelSettings() {
	const current = config();
	const providerId = await choose(
		strings["ai provider"],
		PROVIDERS.map((provider) => [provider.id, providerLabel(provider)]),
		current.provider,
	);
	if (!providerId) return;

	const provider = getProvider(providerId);
	const secretName = secretNameFor(provider);
	const savedKey = await secrets.get(secretName).catch(() => "");
	const sameProvider = providerId === current.provider;
	const inputs = [
		{
			id: "apiKey",
			placeholder: keepHint(
				strings["ai api key"].replace("{provider}", providerLabel(provider)),
				!!savedKey,
			),
			type: "password",
			sensitive: true,
			required: !savedKey,
		},
	];
	if (provider.kind === "openai") {
		inputs.push({
			id: "baseUrl",
			placeholder: strings["ai base url"],
			type: "url",
			value: (sameProvider && current.baseUrl) || provider.baseUrl,
			required: true,
		});
	}

	let values;
	try {
		values = await multiPrompt(strings["ai settings model"], inputs);
	} catch {
		return; // cancelled
	}
	const typedKey = values.apiKey.trim();
	const baseUrl =
		provider.kind === "openai" ? values.baseUrl.trim().replace(/\/+$/, "") : "";
	if (provider.kind === "openai" && !isAllowedBaseUrl(baseUrl)) {
		alert(strings.error, strings["ai invalid base url"]);
		return;
	}

	const model = await chooseModel({
		provider,
		baseUrl,
		apiKey: typedKey || savedKey,
		current: sameProvider ? current.model : provider.defaultModel || "",
	});
	if (!model) return;

	// Conversations are kept in the provider's own format, so another
	// provider or endpoint needs a new session.
	const providerChanged = !sameProvider || baseUrl !== (current.baseUrl || "");
	if (providerChanged && !(await confirmDiscard())) return;
	try {
		if (typedKey) await secrets.set(secretName, typedKey);
	} catch (error) {
		alert(strings.error, error.message);
		return;
	}
	await appSettings.update(
		{ aiAssistant: { ...current, provider: providerId, model, baseUrl } },
		false,
	);

	if (providerChanged || !session) {
		resetSession();
	} else {
		session.ai.model = model;
		showSubtitle();
	}
}

/**
 * Lets the user pick one of the provider's current models, or type one.
 * @param {object} options
 * @param {import("lib/aiAssistant/providers").Provider} options.provider
 * @param {string} options.baseUrl
 * @param {string} options.apiKey
 * @param {string} options.current preselected model
 * @returns {Promise<string|null>}
 */
async function chooseModel({ provider, baseUrl, apiKey, current }) {
	const manual = "\u0000manual";
	let models = [];
	let failure = "";
	try {
		const adapter = await createModelAdapter({
			provider,
			model: current,
			baseUrl,
			apiKey,
		});
		models = await adapter.listModels();
	} catch (error) {
		failure = error?.message || String(error);
	}

	if (models.length) {
		const picked = await choose(
			strings["ai choose model"],
			[...models.map((id) => [id, id]), [manual, strings["ai model manual"]]],
			models.includes(current) ? current : undefined,
		);
		if (picked !== manual) return picked;
	}
	const typed = await prompt(
		failure
			? strings["ai models unavailable"].replace("{error}", failure)
			: strings["ai model"],
		current,
		"text",
		{ required: true },
	);
	return typed ? String(typed).trim() : null;
}

async function openRepoSettings() {
	const current = config();
	const hasToken = await secrets.get("github_token").then(Boolean, () => false);

	let values;
	try {
		values = await multiPrompt(strings["ai settings repo"], [
			{
				id: "owner",
				placeholder: strings["repository owner"],
				type: "text",
				value: current.owner,
				required: true,
			},
			{
				id: "repo",
				placeholder: strings["repository name"],
				type: "text",
				value: current.repo,
				required: true,
			},
			{
				id: "baseBranch",
				placeholder: strings["base branch"],
				type: "text",
				value: current.baseBranch,
				required: true,
			},
			{
				id: "githubToken",
				placeholder: keepHint(strings["github token"], hasToken),
				type: "password",
				sensitive: true,
				required: !hasToken,
			},
		]);
	} catch {
		return; // cancelled
	}

	const next = {
		...current,
		owner: values.owner.trim(),
		repo: values.repo.trim(),
		baseBranch: values.baseBranch.trim(),
	};
	const targetChanged =
		next.owner !== current.owner ||
		next.repo !== current.repo ||
		next.baseBranch !== current.baseBranch;
	if (targetChanged && !(await confirmDiscard())) return;

	try {
		if (values.githubToken) {
			await secrets.set("github_token", values.githubToken.trim());
		}
	} catch (error) {
		alert(strings.error, error.message);
		return;
	}
	await appSettings.update({ aiAssistant: next }, false);

	// The token is read when a session starts, so a new token applies to the
	// next session; a different repository or branch needs a new session now.
	if (targetChanged || !session) resetSession();
}

async function newSession() {
	if (busy || !(await confirmDiscard())) return;
	resetSession();
}

/**
 * Asks before throwing away a conversation or edits that were not merged.
 * @returns {Promise<boolean>} whether it is fine to discard the session
 */
async function confirmDiscard() {
	if (busy) return false;
	const hasWork =
		session &&
		!session.pr?.merged &&
		(session.messages.length || session.changeSet.size);
	if (!hasWork) return true;
	return !!(await confirm(strings.warning, strings["ai discard session"]));
}

function resetSession() {
	clearTimeout(watchTimer);
	session = null;
	expanded.clear();
	$messages.content = "";
	showIntro();
	render();
}

/**
 * Creates the session on first use, so the SDK is only loaded when needed.
 * @returns {Promise<import("lib/aiAssistant/session").default|null>}
 */
async function ensureSession() {
	if (session) return session;

	const { owner, repo, baseBranch, model, baseUrl, ...target } = config();
	const provider = getProvider(target.provider);
	const [apiKey, githubToken] = await Promise.all([
		secrets.get(secretNameFor(provider)),
		secrets.get("github_token"),
	]);
	if (!owner || !repo || !model || !apiKey || !githubToken) {
		alert(strings["ai assistant"], strings["ai setup required"]);
		return null;
	}

	const [
		{ default: AssistantSession },
		{ createGitHubClient },
		{ nativeGetText },
		ai,
	] = await Promise.all([
		import("lib/aiAssistant/session"),
		import("lib/aiAssistant/github"),
		import("lib/aiAssistant/nativeHttp"),
		createModelAdapter({ provider, model, baseUrl, apiKey }),
	]);
	const created = new AssistantSession({
		github: createGitHubClient({ token: githubToken, getText: nativeGetText }),
		ai,
		owner,
		repo,
		baseBranch,
	});
	await created.start();
	session = created;
	return session;
}

function onInputKeyDown(e) {
	// Ctrl/Cmd+Enter sends; plain Enter inserts a newline (soft keyboards).
	if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		send();
	}
}

function onSendClick() {
	if (busy) {
		abortController?.abort();
		return;
	}
	send();
}

/**
 * @param {string} [preset] message to send instead of the input's text
 * @param {string} [display] shorter text to show in the chat for `preset`
 */
async function send(preset, display) {
	const text = (preset ?? $input.value).trim();
	if (!text || busy) return;
	// A merged session is finished; the next request starts a fresh one.
	if (session?.pr?.merged) resetSession();

	setBusy(true);
	if (preset === undefined) {
		$input.value = "";
		autosize.update($input);
	}
	const $user = appendBubble("user", display ?? text);

	/** @type {HTMLElement|null} */
	let $reply = null;
	let replyText = "";
	/** @type {HTMLElement|null} */
	let $thinking = null;

	const finishReply = () => {
		if ($reply) {
			$reply.innerHTML = DOMPurify.sanitize(markdown.render(replyText));
		}
		$reply = null;
		replyText = "";
		$thinking = null;
	};
	let sent = false;

	try {
		const current = await ensureSession();
		if (!current) {
			$user.remove();
			if (preset === undefined) $input.value = text;
			return;
		}
		abortController = new AbortController();
		sent = true;
		await current.send(text, {
			signal: abortController.signal,
			onEvent(event) {
				switch (event.type) {
					case "text":
						if (!$reply) $reply = appendBubble("assistant", "");
						replyText += event.delta;
						$reply.textContent = replyText;
						break;
					case "thinking":
						if (!$thinking) {
							$thinking = <span className="text" />;
							const $block = (
								<div
									className="thinking"
									onclick={() => $block.classList.toggle("expanded")}
								>
									<span className="icon brain" />
									{$thinking}
								</div>
							);
							$messages.append($block);
						}
						$thinking.textContent += event.delta;
						break;
					case "message":
						finishReply();
						break;
					case "tool":
						appendToolLine(event);
						renderChanges();
						break;
					case "refusal":
						finishReply();
						note(strings["ai refused"], "error");
						break;
					case "truncated":
						finishReply();
						note(strings["ai truncated"], "error");
						break;
				}
				scrollToEnd();
			},
		});
	} catch (error) {
		finishReply();
		if (abortController?.signal.aborted) {
			note(strings["ai stopped"]);
		} else {
			note(error?.message || String(error), "error");
		}
		// Nothing reached the conversation: give the text back for a retry.
		if (!sent || error?.userMessageRemoved) {
			$user.remove();
			if (preset === undefined) $input.value = text;
		}
	} finally {
		finishReply();
		abortController = null;
		setBusy(false);
		render();
		scrollToEnd();
	}
}

function setBusy(value) {
	busy = value;
	container?.classList.toggle("busy", value);
	$sendIcon.className = value ? "icon pause" : "icon send";
	renderActions();
}

/**
 * @param {"user"|"assistant"} role
 * @param {string} text
 * @returns {HTMLElement}
 */
function appendBubble(role, text) {
	const $bubble = <div className={`message ${role}`}>{text}</div>;
	$messages.append($bubble);
	scrollToEnd();
	return $bubble;
}

/**
 * @param {string} text
 * @param {"info"|"error"|"success"} [kind="info"]
 */
function note(text, kind = "info") {
	$messages.append(<div className={`note ${kind}`}>{text}</div>);
	scrollToEnd();
}

function appendToolLine({ name, input, isError, result }) {
	const label = input?.path || input?.prefix || "";
	$messages.append(
		<div
			className={`tool ${isError ? "error" : ""}`}
			title={isError ? result : undefined}
		>
			<span className={`icon ${TOOL_ICONS[name] || "code"}`} />
			<span className="label">{label || name}</span>
		</div>,
	);
}

function scrollToEnd() {
	$messages.scrollTop = $messages.scrollHeight;
	$messages.dataset.scrollTop = $messages.scrollTop;
}

/**
 * Links in replies open in the browser, never inside the app's WebView.
 * @param {MouseEvent} e
 */
function onMessageClick(e) {
	const $link = e.target.closest?.("a[href]");
	if (!$link) return;
	e.preventDefault();
	if (/^https?:\/\//i.test($link.href)) system.openInBrowser($link.href);
}

function render() {
	renderChanges();
	renderActions();
}

function renderChanges() {
	const changes = session?.changeSet.list() || [];
	$changes.content = "";
	$changes.classList.toggle("hidden", !changes.length);
	if (!changes.length) return;

	$changes.append(
		<div className="changes-title">
			{strings["ai changes"].replace("{count}", changes.length)}
		</div>,
	);

	const conflicted = new Set(session.unresolvedConflicts);
	for (const change of changes) {
		const { added, removed } = diffStat(change.original, change.content);
		const isOpen = expanded.has(change.path);
		const hasConflict = conflicted.has(change.path);
		const state =
			change.original === null
				? "added"
				: change.content === null
					? "deleted"
					: "modified";
		const $item = (
			<div className={`change ${state} ${hasConflict ? "conflict" : ""}`}>
				<div
					className="change-header"
					onclick={() => {
						if (isOpen) expanded.delete(change.path);
						else expanded.add(change.path);
						renderChanges();
					}}
				>
					<span
						className={`icon ${hasConflict ? "error" : isOpen ? "expand_less" : "expand_more"}`}
					/>
					<span className="path">{change.path}</span>
					<span className="stat">
						<span className="added">+{added}</span>
						<span className="removed">−{removed}</span>
					</span>
					<button
						type="button"
						className="icon-button"
						disabled={busy}
						onclick={(e) => {
							e.stopPropagation();
							revert(change.path);
						}}
					>
						<span className="icon undo" />
					</button>
				</div>
			</div>
		);
		if (isOpen) $item.append(renderDiff(change.original, change.content));
		$changes.append($item);
	}
}

/**
 * @param {string|null} original
 * @param {string|null} content
 * @returns {HTMLElement}
 */
function renderDiff(original, content) {
	const $diff = <pre className="diff" />;
	let shown = 0;
	for (const hunk of diffHunks(original, content)) {
		$diff.append(
			<div className="hunk">
				{`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
			</div>,
		);
		for (const line of hunk.lines) {
			if (shown++ >= MAX_DIFF_LINES) {
				$diff.append(<div className="hunk">…</div>);
				return $diff;
			}
			const prefix =
				line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
			$diff.append(<div className={line.type}>{`${prefix}${line.text}`}</div>);
		}
	}
	return $diff;
}

async function revert(path) {
	const ok = await confirm(
		strings.warning,
		strings["ai revert file"].replace("{path}", path),
	);
	if (!ok || !session) return;
	session.changeSet.revert(path);
	expanded.delete(path);
	render();
}

function renderActions() {
	$actions.content = "";
	if (!session) {
		$actions.classList.add("hidden");
		return;
	}
	$actions.classList.remove("hidden");

	const { pr, readiness, changeSet, workBranch, merging } = session;
	const conflicts = session.unresolvedConflicts;

	if (pr) {
		const $pr = (
			<div className="pr-line">
				<span className={`icon ${pr.merged ? "check_circle" : "github"}`} />
				<span className="pr-title">{`#${pr.number} ${pr.title}`}</span>
				<button
					type="button"
					className="icon-button"
					title={strings["open in browser"]}
					onclick={() => system.openInBrowser(pr.html_url)}
				>
					<span className="icon open_in_browser" />
				</button>
			</div>
		);
		$actions.append($pr);
	} else if (workBranch) {
		$actions.append(<div className="pr-line">{workBranch}</div>);
	}

	if (merging) {
		$actions.append(renderMerging(conflicts));
	} else if (readiness && !pr?.merged) {
		$actions.append(renderReadiness(readiness));
	}

	const buttons = [];
	if (!pr?.merged) {
		buttons.push(
			<button
				type="button"
				disabled={busy || conflicts.length > 0 || (!changeSet.size && !merging)}
				onclick={push}
			>
				<span className="icon publish" />
				{strings["ai push"]}
			</button>,
		);
	}
	if (workBranch && !pr) {
		buttons.push(
			<button
				type="button"
				disabled={busy || changeSet.size > 0}
				onclick={openPullRequest}
			>
				<span className="icon git" />
				{strings["ai create pr"]}
			</button>,
		);
	}
	if (pr && !pr.merged) {
		buttons.push(
			<button type="button" disabled={busy} onclick={checkStatus}>
				<span className="icon refresh" />
				{strings["ai check status"]}
			</button>,
			<button
				type="button"
				className="merge"
				disabled={busy || changeSet.size > 0 || !!merging}
				onclick={merge}
			>
				<span className="icon check" />
				{strings["ai merge"]}
			</button>,
		);
	}
	if (buttons.length) {
		$actions.append(<div className="buttons">{buttons}</div>);
	}
}

/**
 * @param {import("lib/aiAssistant/mergeGate").MergeReadiness} readiness
 * @returns {HTMLElement}
 */
function renderReadiness(readiness) {
	const count = (state) =>
		readiness.checks.filter((check) => check.state === state).length;
	const failed = readiness.checks.filter((check) => check.state === "failure");
	const needsBase = readiness.blockers.some(
		({ code }) => code === "conflict" || code === "behind",
	);
	return (
		<div className={`readiness ${readiness.ready ? "ready" : "blocked"}`}>
			{readiness.checks.length ? (
				<div className="ci">
					{strings["ai ci summary"]
						.replace("{passed}", count("success"))
						.replace("{pending}", count("pending"))
						.replace("{failed}", count("failure"))}
				</div>
			) : (
				""
			)}
			{[...describeBlockers(readiness), ...describeWarnings(readiness)].map(
				(text) => (
					<div className="reason">{text}</div>
				),
			)}
			{failed.length ? (
				<button
					type="button"
					className="fix"
					disabled={busy}
					onclick={() => askToFixCi(failed)}
				>
					<span className="icon wand" />
					{strings["ai fix ci"]}
				</button>
			) : (
				""
			)}
			{needsBase ? (
				<button
					type="button"
					className="fix"
					disabled={busy}
					onclick={syncWithBase}
				>
					<span className="icon git" />
					{strings["ai sync base"].replace("{branch}", session.baseBranch)}
				</button>
			) : (
				""
			)}
		</div>
	);
}

/**
 * Status of an unpushed merge of the base branch into the work branch.
 * @param {string[]} conflicts files that still have conflict markers
 * @returns {HTMLElement}
 */
function renderMerging(conflicts) {
	const branch = session.baseBranch;
	return (
		<div className="readiness blocked">
			<div className="ci">
				{strings["ai merging base"].replace("{branch}", branch)}
			</div>
			{conflicts.length ? (
				<div className="reason">
					{strings["ai merge conflicts"].replace(
						"{paths}",
						conflicts.join(", "),
					)}
				</div>
			) : (
				""
			)}
			<div className="buttons">
				{conflicts.length ? (
					<button
						type="button"
						disabled={busy}
						onclick={() => askToResolveConflicts(conflicts)}
					>
						<span className="icon wand" />
						{strings["ai resolve conflicts"]}
					</button>
				) : (
					""
				)}
				<button type="button" disabled={busy} onclick={abortMerge}>
					<span className="icon clearclose" />
					{strings["ai abort merge"]}
				</button>
			</div>
		</div>
	);
}

/**
 * @param {import("lib/aiAssistant/mergeGate").MergeReadiness} readiness
 * @returns {string[]}
 */
function describeBlockers(readiness) {
	const branch = session?.baseBranch || "";
	return readiness.blockers.map(({ code, names }) =>
		(strings[`ai blocker ${code}`] || code)
			.replace("{branch}", branch)
			.replace("{names}", (names || []).join(", ")),
	);
}

/**
 * @param {import("lib/aiAssistant/mergeGate").MergeReadiness} readiness
 * @returns {string[]}
 */
function describeWarnings(readiness) {
	return readiness.warnings.map(
		(code) => strings[`ai warning ${code}`] || code,
	);
}

/**
 * Runs a GitHub step with the UI locked, reporting failures in the chat.
 * @param {() => Promise<void>} step
 */
async function runStep(step) {
	if (busy || !session) return;
	setBusy(true);
	try {
		await step();
	} catch (error) {
		note(error?.message || String(error), "error");
	} finally {
		setBusy(false);
		render();
		watchCi();
	}
}

/**
 * Re-checks the pull request while CI runs or GitHub computes mergeability,
 * so the user does not have to keep tapping "Check status".
 * @param {number} [delay]
 * @param {number} [polls]
 */
function watchCi(delay = WATCH_FIRST_DELAY, polls = 0) {
	clearTimeout(watchTimer);
	const watched = session;
	if (
		!watched?.readiness?.pending ||
		watched.pr?.merged ||
		polls >= WATCH_MAX_POLLS
	) {
		return;
	}
	watchTimer = setTimeout(async () => {
		if (session !== watched) return;
		if (busy) {
			watchCi(delay, polls);
			return;
		}
		try {
			const readiness = await watched.refreshStatus();
			if (session !== watched) return;
			if (!readiness.pending) announceCiResult(readiness);
		} catch {
			// Retried on the next poll.
		}
		renderActions();
		watchCi(Math.min(delay * 1.5, WATCH_MAX_DELAY), polls + 1);
	}, delay);
}

/**
 * @param {import("lib/aiAssistant/mergeGate").MergeReadiness} readiness
 */
function announceCiResult(readiness) {
	const failed = readiness.checks.filter((check) => check.state === "failure");
	if (failed.length) {
		note(
			strings["ai blocker ci failed"].replace(
				"{names}",
				failed.map((check) => check.name).join(", "),
			),
			"error",
		);
	} else if (readiness.checks.length) {
		note(strings["ai ci passed"], "success");
	}
}

async function push() {
	if (!session?.changeSet.size && !session?.merging) return;
	const message = await prompt(
		strings["commit message"],
		session.merging ? session.mergeMessage : session.briefTitle,
		"textarea",
		{ required: true },
	);
	if (!message) return;
	await runStep(async () => {
		const sha = await session.push(message);
		note(
			strings["ai pushed"]
				.replace("{sha}", sha.slice(0, 7))
				.replace("{branch}", session.workBranch),
			"success",
		);
		if (session.pr) await session.refreshStatus();
	});
}

async function openPullRequest() {
	const title = await prompt(
		strings["ai pr title"],
		session?.briefTitle || "",
		"text",
		{ required: true },
	);
	if (!title) return;
	await runStep(async () => {
		const files = [...session.pushedPaths].map((path) => `- \`${path}\``);
		const pr = await session.openPullRequest({
			title,
			body: `Changes made with the EditorA AI assistant.\n\n${files.join("\n")}`,
		});
		note(strings["ai pr opened"].replace("{number}", pr.number), "success");
		await session.refreshStatus();
	});
}

async function checkStatus() {
	await runStep(() => session.refreshStatus());
}

async function merge() {
	await runStep(async () => {
		const readiness = await session.refreshStatus();
		render();
		if (!readiness.ready) {
			alert(
				strings["ai merge blocked"],
				describeBlockers(readiness).join("\n"),
			);
			return;
		}

		const { number } = session.pr;
		const message = [
			strings["ai merge confirm"]
				.replace("{number}", number)
				.replace("{branch}", session.baseBranch),
			...describeWarnings(readiness),
		].join("\n\n");
		const ok = await confirm(strings["ai merge"], message);
		if (!ok) return;

		// Re-checks the gate and merges exactly the head it checked.
		try {
			await session.merge();
		} catch (error) {
			if (error.readiness) {
				alert(
					strings["ai merge blocked"],
					describeBlockers(error.readiness).join("\n"),
				);
				return;
			}
			throw error;
		}
		note(
			strings["ai merged"]
				.replace("{number}", number)
				.replace("{branch}", session.baseBranch),
			"success",
		);
	});
}

/**
 * Sends the failed checks to the assistant with their annotations and log
 * tails; the chat shows only the short request.
 * @param {{name:string}[]} failed
 */
async function askToFixCi(failed) {
	if (busy || !session) return;
	const request = strings["ai fix ci message"].replace(
		"{names}",
		failed.map((check) => check.name).join(", "),
	);
	let report = "";
	setBusy(true);
	try {
		report = await session.ciFailureReport();
	} catch {
		// The request alone still lets the assistant investigate.
	} finally {
		setBusy(false);
	}
	send(report ? `${request}\n\n${report}` : request, request);
}

async function syncWithBase() {
	await runStep(async () => {
		const branch = session.baseBranch;
		const { upToDate, conflicted } = await session.syncWithBase();
		if (upToDate) {
			note(strings["ai up to date"].replace("{branch}", branch));
			return;
		}
		note(strings["ai merging base"].replace("{branch}", branch));
		if (conflicted.length) {
			note(
				strings["ai merge conflicts"].replace("{paths}", conflicted.join(", ")),
				"error",
			);
		}
	});
}

function abortMerge() {
	if (busy || !session?.merging) return;
	session.abortMerge();
	expanded.clear();
	note(strings["ai merge aborted"].replace("{branch}", session.baseBranch));
	render();
}

/**
 * @param {string[]} conflicts
 */
function askToResolveConflicts(conflicts) {
	send(
		strings["ai resolve conflicts message"]
			.replace("{branch}", session.baseBranch)
			.replace("{paths}", conflicts.join(", ")),
	);
}
