// @vitest-environment happy-dom

import tag from "html-tag-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runAgentTurn } from "../../ai-assistant/core/agent.js";
import * as defaults from "../../ai-assistant/core/defaults.js";
import * as diff from "../../ai-assistant/core/diff.js";
import * as providers from "../../ai-assistant/core/providers.js";
import AssistantSession from "../../ai-assistant/core/session.js";
import * as tools from "../../ai-assistant/core/tools.js";
import { loadSourceModule } from "../helpers/loadSourceModule.js";

// The element helper html-tag-js installs in the app. Unlike the app's JSX
// loader, the test transform keeps whitespace-only text, so text is trimmed.
Object.defineProperty(HTMLElement.prototype, "content", {
	configurable: true,
	set(value) {
		this.replaceChildren(...[value].flat().filter(Boolean));
	},
});

/**
 * Loads the sidebar app with dialogs, storage and GitHub replaced, and a fake
 * Claude client that edits a file on the first turn.
 */
function loadApp({
	settings,
	secretValues = {},
	dialogs = {},
	models = ["claude-opus-5-5"],
	extraTools = [],
	stringValues = {},
}) {
	const github = {
		getBranchHead: vi.fn(async () => ({ commitSha: "base", treeSha: "t0" })),
		listFiles: vi.fn(async () => ({
			files: [{ path: "src/app.js", mode: "100644" }],
			truncated: false,
		})),
		readFile: vi.fn(async () => "const answer = 41;\n"),
		createBranch: vi.fn(async () => ({})),
		commitToBranch: vi.fn(async () => ({ commitSha: "c1", treeSha: "t1" })),
		createPullRequest: vi.fn(async (_o, _r, pr) => ({
			number: 3,
			title: pr.title,
			state: "open",
			merged: false,
			html_url: "https://github.com/o/r/pull/3",
			head: { sha: "c1" },
		})),
		getPullRequest: vi.fn(async () => ({
			number: 3,
			title: "Fix answer",
			state: "open",
			merged: false,
			mergeable: true,
			mergeable_state: "clean",
			html_url: "https://github.com/o/r/pull/3",
			head: { sha: "c1" },
		})),
		listCheckRuns: vi.fn(async () => [
			{ name: "build", status: "completed", conclusion: "success" },
		]),
		getCombinedStatus: vi.fn(async () => ({ statuses: [] })),
		mergePullRequest: vi.fn(async () => ({ merged: true })),
	};

	const replies = [
		{
			stop_reason: "tool_use",
			content: [
				{ type: "text", text: "Fixing it." },
				{
					type: "tool_use",
					id: "t1",
					name: "edit_file",
					input: {
						path: "src/app.js",
						old_string: "41",
						new_string: "42",
					},
				},
				...extraTools,
			],
		},
		{
			stop_reason: "end_turn",
			content: [{ type: "text", text: "Changed **41** to 42." }],
		},
	];
	const claude = {
		beta: {
			messages: {
				stream: vi.fn(() => {
					const reply = replies.shift();
					const handlers = {};
					return {
						on(event, handler) {
							handlers[event] = handler;
						},
						async finalMessage() {
							for (const block of reply.content) {
								if (block.type === "text") handlers.text?.(block.text);
							}
							return reply;
						},
					};
				}),
			},
		},
	};

	const appSettings = {
		value: { aiAssistant: settings },
		update: vi.fn(async (values) => Object.assign(appSettings.value, values)),
	};
	const mocks = {
		alert: vi.fn(),
		confirm: vi.fn(async () => true),
		prompt: vi.fn(async (_message, value) => value),
		multiPrompt: vi.fn(),
		select: vi.fn(),
		openInBrowser: vi.fn(),
		...dialogs,
	};
	// The session talks to the fake Claude client through the real loop.
	const createModelAdapter = vi.fn(async ({ model }) => ({
		model,
		userMessage: (texts) => ({
			role: "user",
			content: texts.map((text) => ({ type: "text", text })),
		}),
		runTurn(options) {
			return runAgentTurn({ client: claude, model: this.model, ...options });
		},
		listModels: async () => {
			if (models instanceof Error) throw models;
			return models;
		},
	}));
	const autosize = Object.assign(() => {}, { update() {} });
	const markdown = () => ({ render: (text) => `<p>${text}</p>` });

	const app = loadSourceModule(
		"src/sidebarApps/aiAssistant/index.js",
		{
			"./style.scss": {},
			autosize: { __esModule: true, default: autosize },
			"components/sidebar": { __esModule: true, default: { on() {} } },
			"dialogs/alert": { __esModule: true, default: mocks.alert },
			"dialogs/confirm": { __esModule: true, default: mocks.confirm },
			"dialogs/multiPrompt": { __esModule: true, default: mocks.multiPrompt },
			"dialogs/prompt": { __esModule: true, default: mocks.prompt },
			"dialogs/select": { __esModule: true, default: mocks.select },
			dompurify: { __esModule: true, default: { sanitize: (html) => html } },
			"../../../ai-assistant/core/defaults.js": defaults,
			"../../../ai-assistant/core/diff.js": diff,
			"lib/aiAssistant/secrets": {
				__esModule: true,
				default: {
					get: vi.fn(async (name) => secretValues[name] || ""),
					set: vi.fn(async (name, value) => {
						secretValues[name] = value;
					}),
				},
			},
			"lib/settings": { __esModule: true, default: appSettings },
			"markdown-it": { __esModule: true, default: markdown },
			"../../../ai-assistant/core/session.js": {
				__esModule: true,
				default: AssistantSession,
			},
			"../../../ai-assistant/core/github.js": {
				createGitHubClient: () => github,
			},
			"../../../ai-assistant/core/providers.js": providers,
			"../../../ai-assistant/core/tools.js": tools,
			"lib/aiAssistant/models": {
				createEditorModelAdapter: createModelAdapter,
				EDITOR_HOST: "the test editor",
			},
			"lib/aiAssistant/nativeHttp": { nativeGetText: vi.fn() },
		},
		{
			tag,
			strings: new Proxy(stringValues, {
				get: (target, key) => (key in target ? target[key] : String(key)),
			}),
			system: { openInBrowser: mocks.openInBrowser },
			AbortController,
			navigator: { onLine: true },
		},
	);

	const [icon, id, title, init] = app.default;
	const container = document.createElement("div");
	document.body.append(container);
	init(container);
	return {
		icon,
		id,
		title,
		container,
		github,
		claude,
		mocks,
		appSettings,
		createModelAdapter,
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const configured = {
	provider: "anthropic",
	model: "claude-opus-5-5",
	owner: "o",
	repo: "r",
	baseBranch: "main",
};
const keys = { anthropic_api_key: "sk-ant", github_token: "ghp" };

/** Clicks the workflow button whose label is the given string key. */
async function clickButton(container, label, settle = flush) {
	const button = [...container.querySelectorAll(".workflow button")].find(
		($button) => $button.textContent.trim() === label,
	);
	expect(button, label).toBeTruthy();
	expect(button.disabled, `${label} disabled`).toBe(false);
	button.click();
	for (let i = 0; i < 5; i++) await settle();
}

beforeEach(() => {
	document.body.replaceChildren();
});

afterEach(() => {
	vi.useRealTimers();
});

it("registers as a sidebar app and starts on this project's repository", () => {
	// Earlier versions saved the repository fields empty.
	const { icon, id, title, container } = loadApp({
		settings: { owner: "", repo: "" },
	});
	expect([icon, id, title]).toEqual([
		"chat_bubble",
		"aiAssistant",
		"ai assistant",
	]);
	expect(container.querySelector(".subtitle").textContent).toBe(
		"ichirocc/EditorA · main · Google Gemini: gemini-3.5-flash",
	);
	expect(container.querySelector(".note").textContent).toBe(
		"ai session started",
	);
	expect(container.querySelector(".workflow").classList).toContain("hidden");
});

it("starts with Gemini until a provider is chosen", async () => {
	// Earlier versions saved the default Claude model without a provider.
	const { container } = loadApp({
		settings: { model: "claude-opus-5-5", owner: "o", repo: "r" },
	});
	expect(container.querySelector(".subtitle").textContent).toBe(
		"o/r · main · Google Gemini: gemini-3.5-flash",
	);
});

it("does not start a session without credentials", async () => {
	const { container, mocks, github } = loadApp({ settings: configured });
	container.querySelector("textarea").value = "Fix it";
	container.querySelector(".composer button").click();
	for (let i = 0; i < 5; i++) await flush();

	expect(mocks.alert).toHaveBeenCalledWith(
		"ai assistant",
		"ai setup missing<br>ai setup missing item<br>ai setup missing item",
	);
	expect(github.getBranchHead).not.toHaveBeenCalled();
	expect(container.querySelector("textarea").value).toBe("Fix it");
	expect(container.querySelector(".message.user")).toBeNull();
});

it("explains a dropped connection and gives the message back", async () => {
	const { container, claude } = loadApp({
		settings: configured,
		secretValues: { ...keys },
		stringValues: { "ai network error": "Offline: {error}" },
	});
	claude.beta.messages.stream = vi.fn(() => {
		throw Object.assign(new Error("No network connection available"), {
			network: true,
		});
	});
	container.querySelector("textarea").value = "コードレビュー";
	container.querySelector(".composer button").click();
	for (let i = 0; i < 10; i++) await flush();

	expect(container.querySelector(".note.error").textContent).toBe(
		"Offline: No network connection available",
	);
	expect(container.querySelector(".message.user")).toBeNull();
	expect(container.querySelector("textarea").value).toBe("コードレビュー");
});

it("says when the model never answered, and gives the message back", async () => {
	const { container, claude } = loadApp({
		settings: configured,
		secretValues: { ...keys },
		stringValues: { "ai no answer": "Silent for {minutes} min" },
	});
	claude.beta.messages.stream = vi.fn(() => {
		throw Object.assign(new Error("No answer from the model for 3 min."), {
			noAnswerMs: 180_000,
		});
	});
	container.querySelector("textarea").value = "コードレビュー";
	container.querySelector(".composer button").click();
	for (let i = 0; i < 10; i++) await flush();

	expect(container.querySelector(".note.error").textContent).toBe(
		"Silent for 3 min",
	);
	expect(container.querySelector(".message.user")).toBeNull();
	expect(container.querySelector("textarea").value).toBe("コードレビュー");
});

it("says when another model answers instead of the chosen one", async () => {
	const { container, createModelAdapter } = loadApp({
		settings: configured,
		secretValues: { ...keys },
		stringValues: { "ai fallback": "{from} → {to}" },
	});
	createModelAdapter.mockImplementation(async ({ model }) => ({
		model,
		userMessage: (texts) => ({ role: "user", content: texts.join("\n\n") }),
		async runTurn({ messages, onEvent }) {
			onEvent({ type: "fallback", from: "big", to: "small" });
			onEvent({ type: "text", delta: "Done." });
			messages.push({ role: "assistant", content: "Done." });
			onEvent({ type: "message" });
		},
	}));
	container.querySelector("textarea").value = "コードレビュー";
	container.querySelector(".composer button").click();
	for (let i = 0; i < 10; i++) await flush();

	expect(
		[...container.querySelectorAll(".note.info")].map((n) => n.textContent),
	).toContain("big → small");
	expect(container.querySelector(".message.assistant").textContent).toBe(
		"Done.",
	);
});

it("says which setting is missing and where to enter it", async () => {
	const { container, mocks } = loadApp({
		settings: { owner: "o", repo: "r" },
		secretValues: { github_token: "ghp" },
		stringValues: {
			"ai setup missing": "Missing:",
			"ai setup missing item": "{item} in {section}",
			"ai api key": "{provider} API key",
			"ai settings model": "AI provider and model",
		},
	});
	container.querySelector("textarea").value = "こんにちは";
	container.querySelector(".composer button").click();
	for (let i = 0; i < 5; i++) await flush();

	// The default provider is Gemini; only its key is missing.
	expect(mocks.alert).toHaveBeenCalledWith(
		"ai assistant",
		"Missing:<br>Google Gemini API key in AI provider and model",
	);
});

it("chats, shows the diff, pushes, opens a PR and merges on request", async () => {
	const { container, github, claude, mocks } = loadApp({
		settings: configured,
		secretValues: { ...keys },
	});
	expect(container.querySelector(".subtitle").textContent).toBe(
		"o/r · main · Anthropic Claude: claude-opus-5-5",
	);

	container.querySelector("textarea").value = "The answer should be 42";
	container.querySelector(".composer button").click();
	for (let i = 0; i < 10; i++) await flush();

	expect(claude.beta.messages.stream).toHaveBeenCalledTimes(2);
	expect(container.querySelector(".message.user").textContent).toBe(
		"The answer should be 42",
	);
	const replies = [...container.querySelectorAll(".message.assistant")];
	expect(replies.map(($reply) => $reply.innerHTML)).toEqual([
		"<p>Fixing it.</p>",
		"<p>Changed **41** to 42.</p>",
	]);
	expect(container.querySelector(".tool .label").textContent).toBe(
		"src/app.js",
	);

	// The staged change is listed with its line counts; tapping shows the diff.
	expect(container.querySelector(".changes-title").textContent.trim()).toBe(
		"ai changes",
	);
	container.querySelector(".change-header").click();
	expect(
		[...container.querySelectorAll(".diff > div")].map(($l) =>
			$l.textContent.trim(),
		),
	).toEqual(["@@ -1,1 +1,1 @@", "-const answer = 41;", "+const answer = 42;"]);

	// Nothing reaches GitHub until the user pushes.
	expect(github.createBranch).not.toHaveBeenCalled();
	await clickButton(container, "ai push");
	expect(mocks.prompt).toHaveBeenCalledWith(
		"commit message",
		"The answer should be 42",
		"textarea",
		{ required: true },
	);
	expect(github.commitToBranch).toHaveBeenCalledOnce();
	expect(container.querySelector(".changes").classList).toContain("hidden");

	await clickButton(container, "ai create pr");
	expect(github.createPullRequest.mock.calls[0][2].body).toContain(
		"- `src/app.js`",
	);
	expect(github.createPullRequest.mock.calls[0][2].title).toBe(
		"The answer should be 42",
	);
	// The line shows the pull request as GitHub reports it after refreshing.
	expect(container.querySelector(".pr-title").textContent).toBe(
		"#3 Fix answer",
	);
	expect(container.querySelector(".readiness").classList).toContain("ready");

	await clickButton(container, "ai merge");
	expect(mocks.confirm).toHaveBeenCalledWith(
		"ai merge",
		"ai merge confirm",
		true,
	);
	expect(github.mergePullRequest).toHaveBeenCalledWith("o", "r", 3, {
		sha: "c1",
		merge_method: "squash",
		commit_title: "Fix answer (#3)",
	});

	container.querySelector(".pr-line .icon-button").click();
	expect(mocks.openInBrowser).toHaveBeenCalledWith(
		"https://github.com/o/r/pull/3",
	);
});

it("pushes for the assistant only after the user confirms", async () => {
	for (const answer of [false, true]) {
		const { container, github, mocks } = loadApp({
			settings: configured,
			secretValues: { ...keys },
			dialogs: { confirm: vi.fn(async () => answer) },
			extraTools: [
				{
					type: "tool_use",
					id: "t2",
					name: "push_changes",
					input: { message: "Fix the answer" },
				},
			],
		});
		container.querySelector("textarea").value = "Fix it and push";
		container.querySelector(".composer button").click();
		for (let i = 0; i < 10; i++) await flush();

		// The dialog shows HTML, so line breaks become <br>.
		expect(mocks.confirm).toHaveBeenCalledWith(
			"ai push",
			"ai confirm push<br><br>src/app.js",
			true,
		);
		const labels = [...container.querySelectorAll(".tool .label")].map(
			($label) => $label.textContent,
		);
		expect(labels).toEqual(["src/app.js", "Fix the answer"]);
		if (answer) {
			expect(github.commitToBranch).toHaveBeenCalledOnce();
			expect(container.querySelector(".changes").classList).toContain("hidden");
		} else {
			expect(github.createBranch).not.toHaveBeenCalled();
			expect(github.commitToBranch).not.toHaveBeenCalled();
		}
	}
});

it("does not merge when the user cancels the confirmation", async () => {
	const { container, github } = loadApp({
		settings: configured,
		secretValues: { ...keys },
		dialogs: {
			confirm: vi.fn(async () => false),
		},
	});
	container.querySelector("textarea").value = "Fix";
	container.querySelector(".composer button").click();
	for (let i = 0; i < 10; i++) await flush();
	await clickButton(container, "ai push");
	await clickButton(container, "ai create pr");
	await clickButton(container, "ai merge");

	expect(github.mergePullRequest).not.toHaveBeenCalled();
});

it("saves repository settings without putting the token in the settings file", async () => {
	const secretValues = {};
	const { container, appSettings, mocks } = loadApp({
		settings: { ...configured, owner: "", repo: "" },
		secretValues,
		dialogs: {
			select: vi.fn(async () => "repo"),
			multiPrompt: vi.fn(async () => ({
				owner: " me ",
				repo: "proj",
				baseBranch: "main",
				githubToken: " ghp_secret ",
			})),
		},
	});
	container.querySelectorAll(".header .icon-button")[1].click();
	for (let i = 0; i < 5; i++) await flush();

	expect(mocks.select.mock.calls[0][1]).toEqual([
		["model", "ai settings model"],
		["repo", "ai settings repo"],
	]);
	expect(appSettings.update).toHaveBeenCalledWith(
		{
			aiAssistant: {
				provider: "anthropic",
				model: "claude-opus-5-5",
				baseUrl: "",
				owner: "me",
				repo: "proj",
				baseBranch: "main",
			},
		},
		false,
	);
	expect(JSON.stringify(appSettings.value)).not.toContain("secret");
	expect(secretValues).toEqual({ github_token: "ghp_secret" });
	expect(container.querySelector(".subtitle").textContent).toBe(
		"me/proj · main · Anthropic Claude: claude-opus-5-5",
	);
});

it("switches to DeepSeek with a model picked from the provider's list", async () => {
	const secretValues = { ...keys };
	const select = vi
		.fn()
		.mockResolvedValueOnce("model")
		.mockResolvedValueOnce("deepseek")
		.mockResolvedValueOnce("deepseek-pro");
	const { container, appSettings, mocks, createModelAdapter } = loadApp({
		settings: configured,
		secretValues,
		models: ["deepseek-flash", "deepseek-pro"],
		dialogs: {
			select,
			multiPrompt: vi.fn(async () => ({
				apiKey: " sk-ds ",
				baseUrl: "https://api.deepseek.com/",
			})),
		},
	});
	container.querySelectorAll(".header .icon-button")[1].click();
	for (let i = 0; i < 10; i++) await flush();

	// Provider list, then the key and endpoint, then the live model list.
	expect(select.mock.calls[1][1]).toContainEqual(["deepseek", "DeepSeek"]);
	expect(select.mock.calls[1][2].default).toBe("anthropic");
	expect(mocks.multiPrompt.mock.calls[0][1].map((input) => input.id)).toEqual([
		"apiKey",
		"baseUrl",
	]);
	expect(createModelAdapter).toHaveBeenCalledWith({
		provider: providers.getProvider("deepseek"),
		model: "deepseek-flash",
		baseUrl: "https://api.deepseek.com",
		apiKey: "sk-ds",
	});
	expect(select.mock.calls[2][1]).toEqual([
		["deepseek-flash", "deepseek-flash"],
		["deepseek-pro", "deepseek-pro"],
		["\u0000manual", "ai model manual"],
	]);
	expect(select.mock.calls[2][2].default).toBe("deepseek-flash");

	expect(appSettings.update).toHaveBeenCalledWith(
		{
			aiAssistant: {
				...configured,
				provider: "deepseek",
				model: "deepseek-pro",
				baseUrl: "https://api.deepseek.com",
			},
		},
		false,
	);
	expect(secretValues.ai_key_deepseek).toBe("sk-ds");
	expect(JSON.stringify(appSettings.value)).not.toContain("sk-ds");
	expect(container.querySelector(".subtitle").textContent).toBe(
		"o/r · main · DeepSeek: deepseek-pro",
	);
});

it("asks for a model name when the model list cannot be loaded", async () => {
	const select = vi
		.fn()
		.mockResolvedValueOnce("model")
		.mockResolvedValueOnce("custom");
	const { container, appSettings, mocks } = loadApp({
		settings: configured,
		secretValues: { ...keys },
		models: new Error("401: bad key"),
		dialogs: {
			select,
			multiPrompt: vi.fn(async () => ({
				apiKey: "local",
				baseUrl: "http://localhost:11434/v1",
			})),
			prompt: vi.fn(async () => " qwen-coder "),
		},
	});
	container.querySelectorAll(".header .icon-button")[1].click();
	for (let i = 0; i < 10; i++) await flush();

	expect(mocks.prompt).toHaveBeenCalledWith(
		"ai models unavailable",
		"",
		"text",
		{ required: true },
	);
	expect(appSettings.update.mock.calls[0][0].aiAssistant).toMatchObject({
		provider: "custom",
		model: "qwen-coder",
		baseUrl: "http://localhost:11434/v1",
	});
});

it("refuses a plain HTTP endpoint that is not on the device", async () => {
	const select = vi
		.fn()
		.mockResolvedValueOnce("model")
		.mockResolvedValueOnce("custom");
	const { container, appSettings, mocks } = loadApp({
		settings: configured,
		secretValues: { ...keys },
		dialogs: {
			select,
			multiPrompt: vi.fn(async () => ({
				apiKey: "k",
				baseUrl: "http://192.168.1.5:11434/v1",
			})),
		},
	});
	container.querySelectorAll(".header .icon-button")[1].click();
	for (let i = 0; i < 10; i++) await flush();

	expect(mocks.alert).toHaveBeenCalledWith("error", "ai invalid base url");
	expect(appSettings.update).not.toHaveBeenCalled();
});

it("merges the base branch in when the pull request conflicts", async () => {
	const { container, github, mocks } = loadApp({
		settings: configured,
		secretValues: { ...keys },
	});
	container.querySelector("textarea").value = "The answer should be 42";
	container.querySelector(".composer button").click();
	for (let i = 0; i < 10; i++) await flush();
	await clickButton(container, "ai push");

	// main changed the same line after the work branch was created.
	const conflicting = {
		...(await github.getPullRequest()),
		mergeable: false,
		mergeable_state: "dirty",
	};
	github.getPullRequest.mockResolvedValue(conflicting);
	await clickButton(container, "ai create pr");
	expect(container.querySelector(".reason").textContent).toBe(
		"ai blocker conflict",
	);

	github.getBranchHead.mockResolvedValue({
		commitSha: "main2",
		treeSha: "tm2",
	});
	github.compare = vi.fn(async (_o, _r, from) =>
		from === "main2"
			? {
					behind_by: 1,
					merge_base_commit: { sha: "base" },
					files: [{ filename: "src/app.js", status: "modified" }],
				}
			: { files: [{ filename: "src/app.js", status: "modified" }] },
	);
	github.readFile.mockImplementation(async (_o, _r, _path, ref) =>
		ref === "c1"
			? "const answer = 42;\n"
			: ref === "main2"
				? "const answer = 43;\n"
				: "const answer = 41;\n",
	);
	await clickButton(container, "ai sync base");

	expect(container.querySelector(".change").classList).toContain("conflict");
	expect(
		[...container.querySelectorAll(".workflow .reason")].map(($r) =>
			$r.textContent.trim(),
		),
	).toEqual(["ai merge conflicts"]);
	const push = [...container.querySelectorAll(".workflow button")].find(
		($button) => $button.textContent.trim() === "ai push",
	);
	expect(push.disabled).toBe(true);
	expect(
		[...container.querySelectorAll(".workflow button")].some(
			($button) =>
				$button.textContent.trim() === "ai merge" && !$button.disabled,
		),
	).toBe(false);

	// Cancelling drops the merge and nothing was committed for it.
	await clickButton(container, "ai abort merge");
	expect(container.querySelector(".changes").classList).toContain("hidden");
	expect(github.commitToBranch).toHaveBeenCalledOnce();
	expect(mocks.alert).not.toHaveBeenCalled();
});

it("keeps checking CI while it runs and reports the result", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const tick = () => vi.advanceTimersByTimeAsync(0);
	const { container, github } = loadApp({
		settings: configured,
		secretValues: { ...keys },
	});
	github.listCheckRuns.mockResolvedValue([
		{ name: "build", status: "in_progress", conclusion: null },
	]);
	container.querySelector("textarea").value = "Fix";
	container.querySelector(".composer button").click();
	for (let i = 0; i < 10; i++) await tick();
	await clickButton(container, "ai push", tick);
	await clickButton(container, "ai create pr", tick);
	expect(github.listCheckRuns).toHaveBeenCalledTimes(1);
	expect(container.querySelector(".reason").textContent).toBe(
		"ai blocker ci running",
	);

	// Still running at the first poll; passing at the second (1.5x later).
	await vi.advanceTimersByTimeAsync(15_000);
	expect(github.listCheckRuns).toHaveBeenCalledTimes(2);
	github.listCheckRuns.mockResolvedValue([
		{ name: "build", status: "completed", conclusion: "success" },
	]);
	await vi.advanceTimersByTimeAsync(22_500);
	expect(github.listCheckRuns).toHaveBeenCalledTimes(3);
	expect(
		[...container.querySelectorAll(".note.success")].map(
			($n) => $n.textContent,
		),
	).toContain("ai ci passed");
	expect(container.querySelector(".readiness").classList).toContain("ready");

	// Nothing is pending any more, so polling stops.
	await vi.advanceTimersByTimeAsync(120_000);
	expect(github.listCheckRuns).toHaveBeenCalledTimes(3);
});
