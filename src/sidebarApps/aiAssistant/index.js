import "./style.scss";
import autosize from "autosize";
import Sidebar from "components/sidebar";
import alert from "dialogs/alert";
import confirm from "dialogs/confirm";
import multiPrompt from "dialogs/multiPrompt";
import prompt from "dialogs/prompt";
import DOMPurify from "dompurify";
import { diffHunks, diffStat } from "lib/aiAssistant/diff";
import secrets from "lib/aiAssistant/secrets";
import appSettings from "lib/settings";
import markdownIt from "markdown-it";

const MAX_DIFF_LINES = 400;
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
		model: "claude-opus-5-5",
		owner: "",
		repo: "",
		baseBranch: "main",
		...appSettings.value.aiAssistant,
	};
}

function showIntro() {
	const { owner, repo, baseBranch } = config();
	if (!owner || !repo) {
		$subtitle.textContent = "";
		note(strings["ai setup required"]);
		return;
	}
	$subtitle.textContent = `${owner}/${repo} · ${baseBranch}`;
	note(
		strings["ai session started"]
			.replace("{repo}", `${owner}/${repo}`)
			.replace("{branch}", baseBranch),
	);
}

async function openSettings() {
	const current = config();
	const [hasApiKey, hasToken] = await Promise.all([
		secrets.get("anthropic_api_key").then(Boolean, () => false),
		secrets.get("github_token").then(Boolean, () => false),
	]);
	const keepHint = (name, saved) =>
		saved ? strings["leave empty to keep"].replace("{name}", name) : name;

	let values;
	try {
		values = await multiPrompt(strings["ai settings"], [
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
				id: "model",
				placeholder: strings["ai model"],
				type: "text",
				value: current.model,
				required: true,
			},
			{
				id: "apiKey",
				placeholder: keepHint(strings["anthropic api key"], hasApiKey),
				type: "password",
				sensitive: true,
				required: !hasApiKey,
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
		owner: values.owner.trim(),
		repo: values.repo.trim(),
		baseBranch: values.baseBranch.trim(),
		model: values.model.trim(),
	};
	const targetChanged =
		next.owner !== current.owner ||
		next.repo !== current.repo ||
		next.baseBranch !== current.baseBranch;
	if (targetChanged && !(await confirmDiscard())) return;

	try {
		if (values.apiKey) await secrets.set("anthropic_api_key", values.apiKey);
		if (values.githubToken) {
			await secrets.set("github_token", values.githubToken.trim());
		}
	} catch (error) {
		alert(strings.error, error.message);
		return;
	}

	await appSettings.update({ aiAssistant: next }, false);

	// Keys are read when a session starts, so new keys apply to the next
	// session; a different repository or branch needs a new session now.
	if (targetChanged || !session) {
		resetSession();
	} else {
		session.model = next.model;
	}
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

	const { owner, repo, baseBranch, model } = config();
	const [apiKey, githubToken] = await Promise.all([
		secrets.get("anthropic_api_key"),
		secrets.get("github_token"),
	]);
	if (!owner || !repo || !apiKey || !githubToken) {
		alert(strings["ai assistant"], strings["ai setup required"]);
		return null;
	}

	const [{ default: AssistantSession }, { createGitHubClient }, agent] =
		await Promise.all([
			import("lib/aiAssistant/session"),
			import("lib/aiAssistant/github"),
			import("lib/aiAssistant/agent"),
		]);
	const created = new AssistantSession({
		github: createGitHubClient({ token: githubToken }),
		claude: agent.createClaudeClient(apiKey),
		model,
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
 */
async function send(preset) {
	const text = (preset ?? $input.value).trim();
	if (!text || busy) return;
	// A merged session is finished; the next request starts a fresh one.
	if (session?.pr?.merged) resetSession();

	setBusy(true);
	if (preset === undefined) {
		$input.value = "";
		autosize.update($input);
	}
	const $user = appendBubble("user", text);

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

	for (const change of changes) {
		const { added, removed } = diffStat(change.original, change.content);
		const isOpen = expanded.has(change.path);
		const state =
			change.original === null
				? "added"
				: change.content === null
					? "deleted"
					: "modified";
		const $item = (
			<div className={`change ${state}`}>
				<div
					className="change-header"
					onclick={() => {
						if (isOpen) expanded.delete(change.path);
						else expanded.add(change.path);
						renderChanges();
					}}
				>
					<span className={`icon ${isOpen ? "expand_less" : "expand_more"}`} />
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

	const { pr, readiness, changeSet, workBranch } = session;

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

	if (readiness && !pr?.merged) {
		$actions.append(renderReadiness(readiness));
	}

	const buttons = [];
	if (!pr?.merged) {
		buttons.push(
			<button type="button" disabled={busy || !changeSet.size} onclick={push}>
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
				disabled={busy || changeSet.size > 0}
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
	}
}

async function push() {
	if (!session?.changeSet.size) return;
	const message = await prompt(
		strings["commit message"],
		session.briefTitle,
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
 * @param {{name:string, summary?:string}[]} failed
 */
function askToFixCi(failed) {
	const details = failed
		.map(({ name, summary }) => (summary ? `${name}:\n${summary}` : name))
		.join("\n\n");
	send(
		strings["ai fix ci message"].replace(
			"{names}",
			failed.map((check) => check.name).join(", "),
		) + (details ? `\n\n${details}` : ""),
	);
}
