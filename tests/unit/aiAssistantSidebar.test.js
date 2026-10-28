// @vitest-environment happy-dom

import tag from "html-tag-js";
import * as diff from "lib/aiAssistant/diff";
import AssistantSession from "lib/aiAssistant/session";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
function loadApp({ settings, secretValues = {}, dialogs = {} }) {
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
		openInBrowser: vi.fn(),
		...dialogs,
	};
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
			dompurify: { __esModule: true, default: { sanitize: (html) => html } },
			"lib/aiAssistant/diff": diff,
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
			"lib/aiAssistant/session": {
				__esModule: true,
				default: AssistantSession,
			},
			"lib/aiAssistant/github": { createGitHubClient: () => github },
			"lib/aiAssistant/agent": { createClaudeClient: () => claude },
			"lib/aiAssistant/nativeHttp": { nativeGetText: vi.fn() },
		},
		{
			tag,
			strings: new Proxy({}, { get: (_target, key) => String(key) }),
			system: { openInBrowser: mocks.openInBrowser },
			AbortController,
		},
	);

	const [icon, id, title, init] = app.default;
	const container = document.createElement("div");
	document.body.append(container);
	init(container);
	return { icon, id, title, container, github, claude, mocks, appSettings };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const configured = {
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

it("registers as a sidebar app and asks for setup first", () => {
	const { icon, id, title, container } = loadApp({
		settings: { ...configured, owner: "", repo: "" },
	});
	expect([icon, id, title]).toEqual([
		"chat_bubble",
		"aiAssistant",
		"ai assistant",
	]);
	expect(container.querySelector(".note").textContent).toBe(
		"ai setup required",
	);
	expect(container.querySelector(".workflow").classList).toContain("hidden");
});

it("does not start a session without credentials", async () => {
	const { container, mocks, github } = loadApp({ settings: configured });
	container.querySelector("textarea").value = "Fix it";
	container.querySelector(".composer button").click();
	for (let i = 0; i < 5; i++) await flush();

	expect(mocks.alert).toHaveBeenCalledWith("ai assistant", "ai setup required");
	expect(github.getBranchHead).not.toHaveBeenCalled();
	expect(container.querySelector("textarea").value).toBe("Fix it");
	expect(container.querySelector(".message.user")).toBeNull();
});

it("chats, shows the diff, pushes, opens a PR and merges on request", async () => {
	const { container, github, claude, mocks } = loadApp({
		settings: configured,
		secretValues: { ...keys },
	});
	expect(container.querySelector(".subtitle").textContent).toBe("o/r · main");

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
	expect(mocks.confirm).toHaveBeenCalledWith("ai merge", "ai merge confirm");
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

it("saves settings without putting keys in the settings file", async () => {
	const secretValues = {};
	const { container, appSettings } = loadApp({
		settings: { ...configured, owner: "", repo: "" },
		secretValues,
		dialogs: {
			multiPrompt: vi.fn(async () => ({
				owner: " me ",
				repo: "proj",
				baseBranch: "main",
				model: "claude-opus-5-5",
				apiKey: "sk-ant-secret",
				githubToken: " ghp_secret ",
			})),
		},
	});
	container.querySelectorAll(".header .icon-button")[1].click();
	for (let i = 0; i < 5; i++) await flush();

	expect(appSettings.update).toHaveBeenCalledWith(
		{
			aiAssistant: {
				owner: "me",
				repo: "proj",
				baseBranch: "main",
				model: "claude-opus-5-5",
			},
		},
		false,
	);
	expect(JSON.stringify(appSettings.value)).not.toContain("secret");
	expect(secretValues).toEqual({
		anthropic_api_key: "sk-ant-secret",
		github_token: "ghp_secret",
	});
	expect(container.querySelector(".subtitle").textContent).toBe(
		"me/proj · main",
	);
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
