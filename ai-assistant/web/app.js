import { LANG, t } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";

const TOKEN_KEY = "editora-ai-assistant-token";
const WATCH_FIRST_DELAY = 15_000;
const WATCH_MAX_DELAY = 60_000;
const WATCH_MAX_POLLS = 60;
const TOOL_ICONS = {
	list_files: "📁",
	read_file: "📄",
	edit_file: "✎",
	write_file: "✎",
	delete_file: "🗑",
	push_changes: "⇪",
	open_pull_request: "⇄",
	get_pull_request_status: "↻",
	merge_pull_request: "⛙",
};

const $ = (id) => document.getElementById(id);
const $messages = $("messages");
const $changes = $("changes");
const $workflow = $("workflow");
const $input = $("input");
const $send = $("send");

/** Last state from the server. */
let state = { log: [], session: null, settings: {}, saved: {}, providers: [] };
let busy = false;
let streaming = false;
/** @type {Set<string>} */
const expanded = new Set();
let watchTimer;

/**
 * Creates an element. Children are nodes or text (never HTML).
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {...(Node|string|null|false)} children
 */
function h(tag, props = {}, ...children) {
	const el = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (value === undefined || value === null || value === false) continue;
		if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
		else if (key === "className") el.className = value;
		else if (key in el) el[key] = value;
		else el.setAttribute(key, value);
	}
	for (const child of children.flat()) {
		if (child === null || child === undefined || child === false) continue;
		el.append(child instanceof Node ? child : String(child));
	}
	return el;
}

// --- API -------------------------------------------------------------

function token() {
	try {
		return localStorage.getItem(TOKEN_KEY) || "";
	} catch {
		return "";
	}
}

class ApiError extends Error {
	constructor(status, body) {
		super(body?.error || `HTTP ${status}`);
		this.status = status;
		this.body = body || {};
	}
}

/**
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 */
async function api(method, path, body) {
	const response = await fetch(path, {
		method,
		headers: {
			Authorization: `Bearer ${token()}`,
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await response.json().catch(() => ({}));
	if (response.status === 401) {
		askToken();
		throw new ApiError(401, data);
	}
	if (!response.ok) {
		if (data.state) applyState(data.state);
		throw new ApiError(response.status, data);
	}
	return data;
}

function applyState(next) {
	state = { ...state, ...next };
	render();
	watchCi();
}

async function load() {
	try {
		applyState(await api("GET", "/api/state"));
		if (!isConfigured()) openSettings();
	} catch (error) {
		if (error.status !== 401) addLocalNote(error.message, "error");
	}
}

function isConfigured() {
	const { settings = {}, saved = {}, providers = [] } = state;
	const provider = providers.find((p) => p.id === settings.provider);
	const keyName = provider?.secretName || `ai_key_${settings.provider}`;
	return !!(
		settings.owner &&
		settings.repo &&
		settings.model &&
		(saved[keyName] || provider?.keyOptional) &&
		saved.github_token
	);
}

// --- Rendering ---------------------------------------------------------

/** Notes that only live in this page (not stored on the server). */
const localNotes = [];

function addLocalNote(text, level = "info") {
	localNotes.push({ kind: "note", text, level });
	renderMessages();
}

function render() {
	document.documentElement.lang = LANG;
	$("title").textContent = t("title");
	$input.placeholder = t("placeholder");
	$("newSession").title = t("newSession");
	$("openSettings").title = t("settings");
	const { settings = {}, providers = [] } = state;
	const provider = providers.find((p) => p.id === settings.provider);
	const target =
		settings.owner && settings.repo
			? `${settings.owner}/${settings.repo} · ${settings.baseBranch} · `
			: "";
	$("subtitle").textContent = provider
		? `${target}${providerLabel(provider)}: ${settings.model}`
		: "";
	renderMessages();
	renderChanges();
	renderWorkflow();
	$send.textContent = streaming ? "■" : "➤";
	$send.disabled = busy && !streaming;
}

function providerLabel(provider) {
	return provider.id === "custom" ? t("providerCustom") : provider.label;
}

function noteText(entry) {
	if (entry.text) return entry.text;
	return t(`note.${entry.code}`, entry.params || {});
}

let messagesFrame = 0;

/** Re-renders the chat at most once per frame while a reply streams in. */
function scheduleMessages() {
	if (messagesFrame) return;
	messagesFrame = requestAnimationFrame(() => {
		messagesFrame = 0;
		renderMessages();
	});
}

function renderMessages() {
	const atBottom =
		$messages.scrollHeight - $messages.scrollTop - $messages.clientHeight < 40;
	$messages.replaceChildren();
	const { settings = {} } = state;
	$messages.append(
		h(
			"div",
			{ className: "note" },
			isConfigured()
				? t("intro", {
						repo: `${settings.owner}/${settings.repo}`,
						branch: settings.baseBranch,
					})
				: t("setupRequired"),
		),
	);
	for (const entry of [...state.log, ...localNotes]) {
		if (entry.kind === "user") {
			$messages.append(h("div", { className: "message user" }, entry.text));
		} else if (entry.kind === "assistant") {
			const $reply = h("div", { className: "message assistant" });
			$reply.innerHTML = renderMarkdown(entry.text);
			$messages.append($reply);
		} else if (entry.kind === "tool") {
			$messages.append(
				h(
					"div",
					{ className: `tool${entry.error ? " error" : ""}` },
					`${TOOL_ICONS[entry.name] || "•"} ${entry.label || entry.name}`,
				),
			);
		} else if (entry.kind === "note") {
			$messages.append(
				h(
					"div",
					{ className: `note ${entry.level || "info"}` },
					noteText(entry),
				),
			);
		}
	}
	if (atBottom || streaming) $messages.scrollTop = $messages.scrollHeight;
}

function renderChanges() {
	const changes = state.session?.changes || [];
	$changes.classList.toggle("hidden", !changes.length);
	$changes.replaceChildren();
	if (!changes.length) return;
	const conflicts = new Set(state.session.conflicts || []);
	$changes.append(h("strong", {}, t("changes", { count: changes.length })));
	for (const change of changes) {
		const open = expanded.has(change.path);
		const $change = h(
			"div",
			{
				className: `change ${change.state}${conflicts.has(change.path) ? " conflict" : ""}`,
			},
			h(
				"div",
				{
					className: "change-header",
					onclick: () => {
						if (open) expanded.delete(change.path);
						else expanded.add(change.path);
						renderChanges();
					},
				},
				h("span", {}, conflicts.has(change.path) ? "⚠" : open ? "▾" : "▸"),
				h("span", { className: "path" }, change.path),
				h("span", { className: "added" }, `+${change.added}`),
				h("span", { className: "removed" }, `−${change.removed}`),
				h(
					"button",
					{
						type: "button",
						disabled: busy,
						onclick: (event) => {
							event.stopPropagation();
							revert(change.path);
						},
					},
					"↶",
				),
			),
		);
		if (open) $change.append(renderDiff(change));
		$changes.append($change);
	}
}

function renderDiff(change) {
	const $diff = h("div", { className: "diff" });
	for (const hunk of change.hunks) {
		$diff.append(
			h(
				"div",
				{ className: "hunk" },
				`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
			),
		);
		for (const line of hunk.lines) {
			const prefix =
				line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
			$diff.append(h("div", { className: line.type }, prefix + line.text));
		}
	}
	if (change.truncated) $diff.append(h("div", { className: "hunk" }, "…"));
	return $diff;
}

/**
 * Appends nodes, skipping the null placeholders of optional parts
 * (Element.append would insert them as the text "null").
 * @param {HTMLElement} $el
 * @param {...(Node|string|null)} parts
 */
function appendParts($el, ...parts) {
	$el.append(...parts.filter((part) => part !== null && part !== undefined));
}

function describeBlockers(readiness, branch) {
	return readiness.blockers.map(({ code, names }) =>
		t(`blocker.${code}`, { branch, names: (names || []).join(", ") }),
	);
}

function describeWarnings(readiness) {
	return readiness.warnings.map((code) => t(`warning.${code}`));
}

function renderWorkflow() {
	const s = state.session;
	$workflow.classList.toggle("hidden", !s);
	$workflow.replaceChildren();
	if (!s) return;
	const { pr, readiness } = s;

	if (pr) {
		appendParts(
			$workflow,
			h(
				"div",
				{ className: "pr-line" },
				h("span", {}, pr.merged ? "✔" : "⑂"),
				h("span", { className: "pr-title" }, `#${pr.number} ${pr.title}`),
				h(
					"a",
					{ href: pr.url, target: "_blank", rel: "noopener noreferrer" },
					t("openPr"),
				),
			),
		);
	} else if (s.workBranch) {
		appendParts($workflow, h("div", { className: "pr-line" }, s.workBranch));
	}

	if (s.merging) {
		const conflicts = s.conflicts || [];
		appendParts(
			$workflow,
			h("div", { className: "ci" }, t("mergingBase", { branch: s.baseBranch })),
			conflicts.length
				? h(
						"div",
						{ className: "reason" },
						t("conflicts", { paths: conflicts.join(", ") }),
					)
				: null,
			h(
				"div",
				{ className: "buttons" },
				conflicts.length
					? h(
							"button",
							{
								type: "button",
								disabled: busy,
								onclick: () =>
									send(
										t("resolveConflictsMessage", {
											branch: s.baseBranch,
											paths: conflicts.join(", "),
										}),
									),
							},
							t("resolveConflicts"),
						)
					: null,
				h(
					"button",
					{
						type: "button",
						disabled: busy,
						onclick: () => step("/api/session/abort-merge"),
					},
					t("abortMerge"),
				),
			),
		);
	} else if (readiness && !pr?.merged) {
		const count = (value) =>
			readiness.checks.filter((check) => check.state === value).length;
		const failed = readiness.checks.filter(
			(check) => check.state === "failure",
		);
		const needsBase = readiness.blockers.some(
			({ code }) => code === "conflict" || code === "behind",
		);
		appendParts(
			$workflow,
			readiness.checks.length
				? h(
						"div",
						{ className: `ci${readiness.ready ? " ready" : ""}` },
						t("ciSummary", {
							passed: count("success"),
							pending: count("pending"),
							failed: count("failure"),
						}),
					)
				: null,
			...[
				...describeBlockers(readiness, s.baseBranch),
				...describeWarnings(readiness),
			].map((text) => h("div", { className: "reason" }, text)),
			failed.length || needsBase
				? h(
						"div",
						{ className: "buttons" },
						failed.length
							? h(
									"button",
									{
										type: "button",
										disabled: busy,
										onclick: () => askToFixCi(failed),
									},
									t("fixCi"),
								)
							: null,
						needsBase
							? h(
									"button",
									{
										type: "button",
										disabled: busy,
										onclick: () => step("/api/session/sync"),
									},
									t("syncBase", { branch: s.baseBranch }),
								)
							: null,
					)
				: null,
		);
	}

	const changes = s.changes.length;
	const conflicts = (s.conflicts || []).length;
	const buttons = [];
	if (!pr?.merged) {
		buttons.push(
			h(
				"button",
				{
					type: "button",
					disabled: busy || conflicts > 0 || (!changes && !s.merging),
					onclick: push,
				},
				t("push"),
			),
		);
	}
	if (s.workBranch && !pr) {
		buttons.push(
			h(
				"button",
				{
					type: "button",
					disabled: busy || changes > 0,
					onclick: openPullRequest,
				},
				t("createPr"),
			),
		);
	}
	if (pr && !pr.merged) {
		buttons.push(
			h(
				"button",
				{
					type: "button",
					disabled: busy,
					onclick: () => step("/api/session/refresh"),
				},
				t("checkStatus"),
			),
			h(
				"button",
				{
					type: "button",
					// Green only when the last check allowed merging.
					className: readiness?.ready ? "merge" : "",
					disabled: busy || changes > 0 || s.merging,
					onclick: merge,
				},
				t("merge"),
			),
		);
	}
	if (buttons.length)
		appendParts($workflow, h("div", { className: "buttons" }, buttons));
}

// --- Actions -------------------------------------------------------------

function setBusy(value) {
	busy = value;
	render();
}

/**
 * Calls a session endpoint that returns the new state.
 * @param {string} path
 * @param {object} [body]
 * @returns {Promise<any>} the response, or null on failure
 */
async function step(path, body = {}) {
	if (busy) return null;
	setBusy(true);
	try {
		const data = await api("POST", path, body);
		busy = false;
		applyState(data);
		return data;
	} catch (error) {
		busy = false;
		if (error.status !== 401) addLocalNote(error.message, "error");
		render();
		return null;
	}
}

/**
 * Sends a message and streams the assistant's turn.
 * @param {string} [preset] text to send instead of the input
 * @param {string} [display] shorter text shown in the chat for `preset`
 */
async function send(preset, display) {
	const text = (preset ?? $input.value).trim();
	if (!text || busy) return;
	if (preset === undefined) $input.value = "";
	streaming = true;
	setBusy(true);

	const userEntry = { kind: "user", text: display ?? text };
	const log = [...state.log, userEntry];
	let reply = null;
	let removed = false;
	state = { ...state, log };
	render();

	try {
		const response = await fetch("/api/session/message", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token()}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ text, display }),
		});
		if (!response.ok) {
			const data = await response.json().catch(() => ({}));
			if (response.status === 401) askToken();
			throw new ApiError(response.status, data);
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		while (true) {
			const { value, done } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			const events = buffer.split("\n\n");
			buffer = done ? "" : events.pop();
			for (const raw of events) {
				const line = raw.trim();
				if (!line.startsWith("data:")) continue;
				const event = JSON.parse(line.slice(5));
				if (event.type === "text") {
					if (!reply) {
						reply = { kind: "assistant", text: "" };
						log.push(reply);
					}
					reply.text += event.delta;
				} else if (event.type === "message") {
					reply = null;
				} else if (event.type === "tool") {
					log.push({
						kind: "tool",
						name: event.name,
						label: toolLabel(event.input),
						error: event.isError,
					});
				} else if (event.type === "approval") {
					render();
					await answerApproval(event);
				} else if (event.type === "error") {
					removed = event.userMessageRemoved;
				} else if (event.type === "done") {
					state = { ...state, ...event.state };
					// The request failed before the assistant replied: give the
					// text back so it can be sent again.
					if (removed && preset === undefined) $input.value = text;
				}
				scheduleMessages();
			}
			if (done) break;
		}
	} catch (error) {
		if (error.body?.code === "setup") openSettings();
		addLocalNote(error.message, "error");
		state = { ...state, log: log.filter((entry) => entry !== userEntry) };
		if (preset === undefined) $input.value = text;
	} finally {
		streaming = false;
		busy = false;
		render();
		watchCi();
	}
}

/** Same as the server's: what a tool call worked on. */
function toolLabel(input) {
	const label =
		input?.path || input?.prefix || input?.title || input?.message || "";
	return String(label).split("\n")[0];
}

/**
 * Asks the user about a GitHub step the assistant wants to take. The turn
 * waits on the server until the answer arrives.
 * @param {{id:string, request:any}} event
 */
async function answerApproval({ id, request }) {
	const allow = confirm(describeApproval(request));
	try {
		await api("POST", "/api/session/approve", { id, allow });
	} catch (error) {
		// The turn was stopped meanwhile.
		addLocalNote(error.message, "error");
	}
}

function describeApproval(request) {
	if (request.action === "push") {
		return t("approve.push", {
			count: request.paths.length,
			branch: request.branch || t("approve.newBranch"),
			paths: request.paths.map((path) => `• ${path}`).join("\n"),
			message: request.message,
		});
	}
	if (request.action === "pr") {
		return t("approve.pr", {
			branch: request.baseBranch,
			title: request.title,
		});
	}
	return [
		t("approve.merge"),
		t("mergeConfirm", { number: request.number, branch: request.baseBranch }),
		...describeWarnings(request),
	].join("\n\n");
}

async function stop() {
	try {
		await api("POST", "/api/session/stop", {});
	} catch {
		// The turn ends on its own.
	}
}

async function revert(path) {
	if (!confirm(t("revertConfirm", { path }))) return;
	expanded.delete(path);
	await step("/api/session/revert", { path });
}

async function push() {
	const s = state.session;
	const message = prompt(
		t("commitMessage"),
		s.merging ? s.mergeMessage : s.briefTitle,
	);
	if (!message?.trim()) return;
	await step("/api/session/push", { message });
}

async function openPullRequest() {
	const title = prompt(t("prTitle"), state.session.briefTitle);
	if (!title?.trim()) return;
	await step("/api/session/pr", { title });
}

async function merge() {
	const data = await step("/api/session/refresh");
	if (!data) return;
	const s = state.session;
	const { readiness, pr } = s;
	if (!readiness.ready) {
		alert(
			[t("mergeBlocked"), ...describeBlockers(readiness, s.baseBranch)].join(
				"\n",
			),
		);
		return;
	}
	const message = [
		t("mergeConfirm", { number: pr.number, branch: s.baseBranch }),
		...describeWarnings(readiness),
	].join("\n\n");
	if (!confirm(message)) return;
	// The server refuses if the head is no longer the one confirmed here.
	await step("/api/session/merge", { headSha: pr.headSha });
}

async function askToFixCi(failed) {
	const request = t("fixCiMessage", {
		names: failed.map((check) => check.name).join(", "),
	});
	const data = await step("/api/session/ci-report");
	const report = data?.report || "";
	send(report ? `${request}\n\n${report}` : request, request);
}

async function newSession() {
	if (busy) return;
	try {
		applyState(await api("POST", "/api/session/reset", {}));
	} catch (error) {
		if (error.body?.code !== "discard") {
			addLocalNote(error.message, "error");
			return;
		}
		if (!confirm(t("discardConfirm"))) return;
		applyState(await api("POST", "/api/session/reset", { discard: true }));
	}
	localNotes.length = 0;
	expanded.clear();
	render();
}

/**
 * Re-checks the pull request while CI runs, so the user does not have to
 * keep tapping "Check status". It never merges.
 */
function watchCi(delay = WATCH_FIRST_DELAY, polls = 0) {
	clearTimeout(watchTimer);
	if (!state.session?.readiness?.pending || polls >= WATCH_MAX_POLLS) return;
	watchTimer = setTimeout(async () => {
		if (busy) {
			watchCi(delay, polls);
			return;
		}
		try {
			const next = await api("POST", "/api/session/refresh", {});
			state = { ...state, ...next };
			const readiness = next.session?.readiness;
			if (readiness && !readiness.pending) {
				const failed = readiness.checks.filter((c) => c.state === "failure");
				if (failed.length) {
					addLocalNote(
						t("blocker.ci failed", {
							names: failed.map((c) => c.name).join(", "),
						}),
						"error",
					);
				} else if (readiness.checks.length) {
					addLocalNote(t("ciPassed"), "success");
				}
			}
			render();
		} catch {
			// Retried on the next poll.
		}
		watchCi(Math.min(delay * 1.5, WATCH_MAX_DELAY), polls + 1);
	}, delay);
}

// --- Settings ------------------------------------------------------------

function fillSettings() {
	const { settings, providers, saved } = state;
	const $provider = $("provider");
	const groups = new Map();
	for (const provider of providers) {
		if (!groups.has(provider.group)) groups.set(provider.group, []);
		groups.get(provider.group).push(provider);
	}
	$provider.replaceChildren(
		...[...groups].map(([group, members]) =>
			h(
				"optgroup",
				{ label: t(`group.${group}`) },
				members.map((provider) =>
					h("option", { value: provider.id }, providerLabel(provider)),
				),
			),
		),
	);
	$provider.value = settings.provider;
	$("model").value = settings.model || "";
	$("owner").value = settings.owner || "";
	$("repo").value = settings.repo || "";
	$("baseBranch").value = settings.baseBranch || "main";
	$("githubToken").value = "";
	$("githubToken").placeholder = saved.github_token ? t("keySaved") : "";
	$("modelList").replaceChildren();
	$("modelsStatus").textContent = "";
	$("settingsError").textContent = "";
	onProviderChange(false);
}

/**
 * @param {boolean} [userChanged] reset the URL and model for the new provider
 */
function onProviderChange(userChanged = true) {
	const { settings, providers, saved } = state;
	const provider = providers.find((p) => p.id === $("provider").value);
	const openai = provider.kind === "openai";
	$("baseUrlField").classList.toggle("hidden", !openai);
	const sameProvider = provider.id === settings.provider;
	$("baseUrl").value = openai
		? (sameProvider && settings.baseUrl) || provider.baseUrl || ""
		: "";
	if (userChanged) {
		$("model").value = sameProvider
			? settings.model
			: provider.defaultModel || "";
		$("modelList").replaceChildren();
		$("modelsStatus").textContent = "";
	}
	const keyName = provider.secretName || `ai_key_${provider.id}`;
	$("apiKey").value = "";
	$("apiKey").placeholder = saved[keyName]
		? t("keySaved")
		: provider.keyOptional
			? t("keyOptional")
			: "";
}

async function loadModels() {
	$("modelsStatus").textContent = "…";
	try {
		const { models } = await api("POST", "/api/models", {
			provider: $("provider").value,
			baseUrl: $("baseUrl").value.trim(),
			apiKey: $("apiKey").value.trim(),
		});
		$("modelList").replaceChildren(
			...models.map((model) => h("option", { value: model })),
		);
		$("modelsStatus").textContent = t("modelsLoaded", { count: models.length });
		if (!$("model").value && models.length) $("model").value = models[0];
	} catch (error) {
		$("modelsStatus").textContent = error.message;
	}
}

async function saveSettings(discard = false) {
	const body = {
		settings: {
			provider: $("provider").value,
			baseUrl: $("baseUrl").value.trim(),
			model: $("model").value.trim(),
			owner: $("owner").value.trim(),
			repo: $("repo").value.trim(),
			baseBranch: $("baseBranch").value.trim(),
		},
		apiKey: $("apiKey").value.trim(),
		githubToken: $("githubToken").value.trim(),
		discard,
	};
	try {
		applyState(await api("PUT", "/api/config", body));
		$("apiKey").value = "";
		$("githubToken").value = "";
		$("settingsDialog").close();
	} catch (error) {
		if (error.body?.code === "discard" && confirm(t("discardConfirm"))) {
			await saveSettings(true);
			return;
		}
		$("settingsError").textContent = error.message;
	}
}

function openSettings() {
	if (!state.providers.length) return;
	fillSettings();
	$("settingsTitle").textContent = t("settings");
	if (!$("settingsDialog").open) $("settingsDialog").showModal();
}

function askToken() {
	if (!$("tokenDialog").open) $("tokenDialog").showModal();
}

// --- Start -----------------------------------------------------------------

function start() {
	for (const $el of document.querySelectorAll("[data-t]")) {
		$el.textContent = t($el.dataset.t);
	}

	// The server prints a link with #token=…; keep it and drop it from the URL.
	const match = location.hash.match(/token=([^&]+)/);
	if (match) {
		try {
			localStorage.setItem(TOKEN_KEY, decodeURIComponent(match[1]));
		} catch {
			// Storage blocked: the token is asked for again next time.
		}
		history.replaceState(null, "", location.pathname);
	}

	$("composer").addEventListener("submit", (event) => {
		event.preventDefault();
		if (streaming) stop();
		else send();
	});
	$input.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			send();
		}
	});
	$input.addEventListener("input", () => {
		$input.style.height = "auto";
		$input.style.height = `${$input.scrollHeight}px`;
	});
	$("newSession").addEventListener("click", newSession);
	$("openSettings").addEventListener("click", openSettings);
	$("provider").addEventListener("change", () => onProviderChange());
	$("loadModels").addEventListener("click", loadModels);
	$("cancelSettings").addEventListener("click", () =>
		$("settingsDialog").close(),
	);
	$("settingsForm").addEventListener("submit", (event) => {
		event.preventDefault();
		saveSettings();
	});
	$("tokenForm").addEventListener("submit", () => {
		try {
			localStorage.setItem(TOKEN_KEY, $("tokenInput").value.trim());
		} catch {
			// Kept for this page only.
		}
		$("tokenInput").value = "";
		load();
	});

	render();
	if (token()) load();
	else askToken();
}

start();
