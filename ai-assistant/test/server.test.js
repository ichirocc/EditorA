import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantApp } from "../server/app.js";
import { createConfigStore } from "../server/config.js";

const TOKEN = "test-token";

function fakeGitHub() {
	const pr = {
		number: 7,
		title: "Fix answer",
		state: "open",
		merged: false,
		mergeable: true,
		mergeable_state: "clean",
		html_url: "https://github.com/o/r/pull/7",
		head: { sha: "c1" },
	};
	return {
		getBranchHead: vi.fn(async () => ({ commitSha: "base", treeSha: "t0" })),
		listFiles: vi.fn(async () => ({
			files: [{ path: "a.js", mode: "100644" }],
			truncated: false,
		})),
		readFile: vi.fn(async () => "answer = 41\n"),
		createBranch: vi.fn(async () => ({})),
		commitToBranch: vi.fn(async () => ({ commitSha: "c1", treeSha: "t1" })),
		createPullRequest: vi.fn(async () => pr),
		getPullRequest: vi.fn(async () => pr),
		listCheckRuns: vi.fn(async () => [
			{ name: "build", status: "completed", conclusion: "success" },
		]),
		getCombinedStatus: vi.fn(async () => ({ statuses: [] })),
		mergePullRequest: vi.fn(async () => {
			pr.merged = true;
			pr.state = "closed";
			return { merged: true };
		}),
	};
}

/**
 * A model that edits a.js, waits until stopped when asked to, or gives up
 * as a model that never answered.
 */
function fakeAdapter(model) {
	return {
		model,
		userMessage: (texts) => ({ role: "user", content: texts.join("\n\n") }),
		async runTurn({ messages, executeTool, onEvent, signal }) {
			const last = messages.at(-1).content;
			if (last.includes("silent")) {
				throw Object.assign(new Error("No answer from the model for 3 min."), {
					noAnswerMs: 180_000,
				});
			}
			if (last.includes("busy")) {
				onEvent({ type: "fallback", from: model, to: "model-b" });
			}
			if (last.includes("wait")) {
				await new Promise((_, reject) =>
					signal.addEventListener("abort", () => reject(signal.reason)),
				);
			}
			onEvent({ type: "text", delta: "Fixing " });
			onEvent({ type: "text", delta: "it." });
			// Fails harmlessly once a.js already says 42.
			const result = await executeTool("edit_file", {
				path: "a.js",
				old_string: "41",
				new_string: "42",
			}).catch((error) => error.message);
			onEvent({
				type: "tool",
				name: "edit_file",
				input: { path: "a.js" },
				result,
				isError: false,
			});
			// The user's text comes last, after the app's state note.
			if (last.endsWith("push")) {
				const input = { message: "Fix answer" };
				onEvent({
					type: "tool",
					name: "push_changes",
					input,
					result: await executeTool("push_changes", input),
					isError: false,
				});
			}
			messages.push({ role: "assistant", content: "done" });
			onEvent({ type: "message" });
		},
		listModels: async () => ["model-a", "model-b"],
	};
}

let dir;
let server;
let base;
let github;
let createAdapter;
let store;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "assistant-test-"));
	store = createConfigStore({ dir, env: {} });
	github = fakeGitHub();
	createAdapter = vi.fn(async ({ model }) => fakeAdapter(model));
	const app = createAssistantApp({
		store,
		token: TOKEN,
		createGitHub: () => github,
		createAdapter,
		now: () => new Date("2026-10-28T01:02:03Z"),
	});
	server = http.createServer(app.handle);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
	await new Promise((resolve) => server.close(resolve));
	await rm(dir, { recursive: true, force: true });
});

/**
 * @param {string} method
 * @param {string} url
 * @param {object} [body]
 * @param {string} [token]
 */
async function call(method, url, body, token = TOKEN) {
	const response = await fetch(base + url, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	return { status: response.status, body: await response.json() };
}

/** Sends a chat message and collects the streamed events. */
async function chat(text) {
	const response = await fetch(`${base}/api/session/message`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ text }),
	});
	if (!response.ok)
		return { status: response.status, body: await response.json() };
	const raw = await response.text();
	const events = raw
		.split("\n\n")
		.filter((chunk) => chunk.startsWith("data: "))
		.map((chunk) => JSON.parse(chunk.slice(6)));
	return { status: response.status, events };
}

/** Like chat(), but answers the assistant's approval requests. */
async function chatAnswering(text, allow) {
	const response = await fetch(`${base}/api/session/message`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ text }),
	});
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const events = [];
	let buffer = "";
	while (true) {
		const { value, done } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		const chunks = buffer.split("\n\n");
		buffer = done ? "" : chunks.pop();
		for (const chunk of chunks) {
			if (!chunk.startsWith("data: ")) continue;
			const event = JSON.parse(chunk.slice(6));
			events.push(event);
			if (event.type === "approval") {
				const answer = await call("POST", "/api/session/approve", {
					id: event.id,
					allow,
				});
				expect(answer.status).toBe(200);
			}
		}
		if (done) return events;
	}
}

async function configure(extra = {}) {
	return call("PUT", "/api/config", {
		settings: {
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com/",
			model: "deepseek-flash",
			owner: "o",
			repo: "r",
			baseBranch: "main",
		},
		apiKey: "sk-ds-secret",
		githubToken: "ghp_secret",
		...extra,
	});
}

describe("standalone assistant server", () => {
	it("serves the web UI with a strict content security policy", async () => {
		const response = await fetch(`${base}/`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-security-policy")).toContain(
			"default-src 'self'",
		);
		expect(await response.text()).toContain(
			'<script type="module" src="app.js">',
		);
		expect((await fetch(`${base}/../package.json`)).status).toBe(404);
		expect((await fetch(`${base}/server/app.js`)).status).toBe(404);
	});

	it("requires the access token for every API call", async () => {
		expect((await call("GET", "/api/state", undefined, "wrong")).status).toBe(
			401,
		);
		const response = await fetch(`${base}/api/state`);
		expect(response.status).toBe(401);
		expect((await call("GET", "/api/state")).status).toBe(200);
	});

	it("saves settings and keys without ever returning the keys", async () => {
		const { status, body } = await configure();
		expect(status).toBe(200);
		expect(body.settings).toMatchObject({
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com",
			owner: "o",
		});
		expect(body.saved).toMatchObject({
			ai_key_deepseek: true,
			github_token: true,
		});
		expect(JSON.stringify(body)).not.toMatch(/sk-ds-secret|ghp_secret/);

		const state = await call("GET", "/api/state");
		expect(JSON.stringify(state.body)).not.toMatch(/sk-ds-secret|ghp_secret/);

		// The keys are on disk, readable only by the user.
		const file = path.join(dir, "config.json");
		expect(await readFile(file, "utf8")).toContain("sk-ds-secret");
		expect((await stat(file)).mode & 0o777).toBe(0o600);
	});

	it("rejects invalid settings", async () => {
		expect(
			(
				await configure({
					settings: { provider: "custom", baseUrl: "http://10.0.0.2/v1" },
				})
			).body.code,
		).toBe("base url");
		expect((await configure({ settings: { owner: "o/../x" } })).status).toBe(
			400,
		);
		expect((await configure({ settings: { provider: "nope" } })).status).toBe(
			400,
		);
	});

	it("asks for setup before the first message", async () => {
		const { status, body } = await chat("hello");
		expect(status).toBe(400);
		expect(body.code).toBe("setup");
	});

	it("lists a provider's models with the saved key", async () => {
		await configure();
		const { body } = await call("POST", "/api/models", {
			provider: "deepseek",
		});
		expect(body.models).toEqual(["model-a", "model-b"]);
		expect(createAdapter).toHaveBeenLastCalledWith(
			expect.objectContaining({ apiKey: "sk-ds-secret" }),
		);
	});

	it("needs no API key for a model server on this device", async () => {
		const missing = await call("POST", "/api/models", { provider: "groq" });
		expect(missing.status).toBe(400);

		const listed = await call("POST", "/api/models", { provider: "ollama" });
		expect(listed.body.models).toEqual(["model-a", "model-b"]);
		expect(createAdapter).toHaveBeenLastCalledWith(
			expect.objectContaining({
				baseUrl: "http://localhost:11434/v1",
				apiKey: "",
			}),
		);

		await configure({
			settings: {
				provider: "ollama",
				baseUrl: "http://localhost:11434/v1",
				model: "qwen3:8b",
				owner: "o",
				repo: "r",
				baseBranch: "main",
			},
			apiKey: "",
		});
		const { status, events } = await chat("The answer should be 42");
		expect(status).toBe(200);
		expect(events.at(-1).type).toBe("done");
		expect(createAdapter).toHaveBeenLastCalledWith(
			expect.objectContaining({ model: "qwen3:8b", apiKey: "" }),
		);
	});

	it("streams a turn, then pushes, opens a PR and merges the confirmed head", async () => {
		await configure();
		const { events } = await chat("The answer should be 42");
		expect(events.map((event) => event.type)).toEqual([
			"text",
			"text",
			"tool",
			"message",
			"done",
		]);
		const { state } = events.at(-1);
		expect(state.log.map((entry) => entry.kind)).toEqual([
			"user",
			"assistant",
			"tool",
		]);
		expect(state.log[1].text).toBe("Fixing it.");
		expect(state.session.changes).toEqual([
			expect.objectContaining({
				path: "a.js",
				state: "modified",
				added: 1,
				removed: 1,
			}),
		]);
		expect(
			state.session.changes[0].hunks[0].lines.map((line) => line.type),
		).toEqual(["del", "add"]);
		expect(createAdapter).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "deepseek-flash",
				baseUrl: "https://api.deepseek.com",
				apiKey: "sk-ds-secret",
			}),
		);

		// Nothing reached GitHub until the push.
		expect(github.createBranch).not.toHaveBeenCalled();
		const pushed = await call("POST", "/api/session/push", { message: "Fix" });
		expect(pushed.status).toBe(200);
		expect(github.commitToBranch).toHaveBeenCalledOnce();
		expect(pushed.body.log.at(-1)).toMatchObject({
			code: "pushed",
			params: { sha: "c1", branch: "ai/edit-20261028-010203" },
		});

		const opened = await call("POST", "/api/session/pr", {
			title: "Fix answer",
		});
		expect(opened.body.session.pr).toMatchObject({ number: 7, headSha: "c1" });
		expect(opened.body.session.readiness.ready).toBe(true);

		const stale = await call("POST", "/api/session/merge", { headSha: "old" });
		expect(stale.status).toBe(409);
		expect(stale.body.code).toBe("head changed");
		expect(github.mergePullRequest).not.toHaveBeenCalled();

		const merged = await call("POST", "/api/session/merge", { headSha: "c1" });
		expect(merged.status).toBe(200);
		expect(github.mergePullRequest).toHaveBeenCalledWith("o", "r", 7, {
			sha: "c1",
			merge_method: "squash",
			commit_title: "Fix answer (#7)",
		});
		expect(merged.body.session.phase).toBe("merged");
	});

	it("refuses to merge while CI fails", async () => {
		await configure();
		github.listCheckRuns.mockResolvedValue([
			{ name: "tests", status: "completed", conclusion: "failure" },
		]);
		await chat("fix");
		await call("POST", "/api/session/push", { message: "Fix" });
		await call("POST", "/api/session/pr", { title: "Fix" });

		const { status, body } = await call("POST", "/api/session/merge", {
			headSha: "c1",
		});
		expect(status).toBe(409);
		expect(body.code).toBe("blocked");
		expect(body.readiness.blockers).toEqual([
			{ code: "ci failed", names: ["tests"] },
		]);
		expect(github.mergePullRequest).not.toHaveBeenCalled();
	});

	it("pushes for the assistant only after the user approves in the browser", async () => {
		await configure();
		const declined = await chatAnswering("Fix it and push", false);
		const approval = declined.find((event) => event.type === "approval");
		expect(approval.request).toEqual({
			action: "push",
			message: "Fix answer",
			branch: null,
			paths: ["a.js"],
		});
		expect(github.commitToBranch).not.toHaveBeenCalled();
		const { state } = declined.at(-1);
		expect(state.log).toContainEqual({ kind: "note", code: "declined push" });
		expect(state.log).toContainEqual({
			kind: "tool",
			name: "push_changes",
			label: "Fix answer",
			error: false,
		});

		const approved = await chatAnswering("Now push", true);
		expect(github.commitToBranch).toHaveBeenCalledOnce();
		expect(approved.at(-1).state.session.workBranch).toMatch(/^ai\/edit-/);

		const stale = await call("POST", "/api/session/approve", {
			id: approval.id,
			allow: true,
		});
		expect(stale.status).toBe(409);
	});

	it("stops a running turn on request", async () => {
		await configure();
		const turn = chat("wait for me");
		await vi.waitFor(async () => {
			expect((await call("GET", "/api/state")).body.busy).toBe(true);
		});
		await call("POST", "/api/session/stop", {});
		const { events } = await turn;
		expect(events.at(-2)).toEqual({
			type: "error",
			message: "stopped",
			userMessageRemoved: true,
		});
		expect(events.at(-1).state.log).toEqual([
			{ kind: "note", code: "stopped" },
		]);
	});

	it("shows a translated note when the model never answers", async () => {
		await configure();
		const { events } = await chat("stay silent");
		expect(events.at(-1).state.log).toContainEqual({
			kind: "note",
			code: "no answer",
			level: "error",
			params: { minutes: 3 },
		});
	});

	it("notes when another model answers instead", async () => {
		await configure();
		const { events } = await chat("you seem busy");
		expect(events).toContainEqual({
			type: "fallback",
			from: "deepseek-flash",
			to: "model-b",
		});
		expect(events.at(-1).state.log).toContainEqual({
			kind: "note",
			code: "fallback",
			params: { from: "deepseek-flash", to: "model-b" },
		});
	});

	it("asks before discarding work when the repository changes", async () => {
		await configure();
		await chat("fix");
		const blocked = await configure({ settings: { repo: "other" } });
		expect(blocked.status).toBe(409);
		expect(blocked.body.code).toBe("discard");

		const done = await configure({
			settings: { repo: "other" },
			discard: true,
		});
		expect(done.status).toBe(200);
		expect(done.body.session).toBe(null);
		expect(done.body.settings.repo).toBe("other");
	});

	it("changes the model of a running session without restarting it", async () => {
		await configure();
		await chat("fix");
		const { body } = await configure({ settings: { model: "deepseek-pro" } });
		expect(body.session.model).toBe("deepseek-pro");
		expect(body.session.changes).toHaveLength(1);
	});
});
