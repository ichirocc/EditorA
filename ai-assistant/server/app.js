import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diffHunks, diffStat } from "../core/diff.js";
import { createGitHubClient } from "../core/github.js";
import {
	createModelAdapter,
	getProvider,
	isAllowedBaseUrl,
	PROVIDERS,
	secretNameFor,
} from "../core/providers.js";
import AssistantSession from "../core/session.js";

const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));
const STATIC_FILES = {
	"/": ["index.html", "text/html; charset=utf-8"],
	"/app.js": ["app.js", "text/javascript; charset=utf-8"],
	"/i18n.js": ["i18n.js", "text/javascript; charset=utf-8"],
	"/markdown.js": ["markdown.js", "text/javascript; charset=utf-8"],
	"/style.css": ["style.css", "text/css; charset=utf-8"],
};
const SECURITY_HEADERS = {
	"Content-Security-Policy":
		"default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
};
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_LOG_ENTRIES = 500;
const MAX_DIFF_LINES = 400;
const NAME = /^[A-Za-z0-9_.-]+$/;

class HttpError extends Error {
	/**
	 * @param {number} status
	 * @param {string} message
	 * @param {object} [extra] merged into the JSON body
	 */
	constructor(status, message, extra = {}) {
		super(message);
		this.status = status;
		this.extra = extra;
	}
}

/**
 * GET used for GitHub Actions job logs. Node's fetch follows the redirect to
 * the log host and, as the Fetch standard requires, drops Authorization on
 * the way.
 * @param {string} url
 * @param {Record<string, string>} headers
 */
async function fetchText(url, headers) {
	const response = await fetch(url, { headers });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.text();
}

/**
 * The assistant's HTTP API and web UI for one user and one session at a
 * time. Every API call needs the access token; GitHub is only changed by
 * the push, pull request, merge and base-merge calls the user triggers.
 *
 * @param {object} options
 * @param {import("./config.js").ConfigStore} options.store
 * @param {string} options.token access token the UI sends as a Bearer token
 * @param {(token:string) => any} [options.createGitHub]
 * @param {typeof createModelAdapter} [options.createAdapter]
 * @param {() => Date} [options.now]
 */
export function createAssistantApp({
	store,
	token,
	createGitHub = (githubToken) =>
		createGitHubClient({ token: githubToken, getText: fetchText }),
	createAdapter = createModelAdapter,
	now = () => new Date(),
}) {
	/**@type {AssistantSession|null} */
	let session = null;
	let busy = false;
	/**@type {AbortController|null} */
	let controller = null;
	/** Chat history as shown in the UI (the model's own history is in the session). */
	let log = [];

	const expected = Buffer.from(`Bearer ${token}`);
	const authorized = (req) => {
		const given = Buffer.from(req.headers.authorization || "");
		return given.length === expected.length && timingSafeEqual(given, expected);
	};

	/** @param {object} entry */
	function addLog(entry) {
		log.push(entry);
		if (log.length > MAX_LOG_ENTRIES) log = log.slice(-MAX_LOG_ENTRIES);
		return entry;
	}

	function hasUnmergedWork() {
		return (
			!!session &&
			!session.pr?.merged &&
			(session.messages.length > 0 || session.changeSet.size > 0)
		);
	}

	function resetSession() {
		controller?.abort();
		session = null;
		log = [];
	}

	async function publicSettings() {
		const settings = await store.settings();
		const saved = { github_token: await store.hasSecret("github_token") };
		for (const provider of PROVIDERS) {
			const name = secretNameFor(provider);
			saved[name] = await store.hasSecret(name);
		}
		return { settings, saved };
	}

	function view() {
		const s = session;
		return {
			busy,
			log,
			session: s && {
				phase: s.phase,
				owner: s.owner,
				repo: s.repo,
				baseBranch: s.baseBranch,
				model: s.ai.model,
				workBranch: s.workBranch,
				briefTitle: s.briefTitle,
				mergeMessage: s.workBranch ? s.mergeMessage : "",
				pr: s.pr && {
					number: s.pr.number,
					title: s.pr.title,
					url: s.pr.html_url,
					state: s.pr.state,
					merged: !!s.pr.merged,
					headSha: s.pr.head?.sha || null,
				},
				readiness: s.readiness,
				merging: !!s.merging,
				conflicts: s.unresolvedConflicts,
				changes: s.changeSet.list().map((change) => {
					let shown = 0;
					const hunks = [];
					for (const hunk of diffHunks(change.original, change.content)) {
						if (shown >= MAX_DIFF_LINES) break;
						const lines = hunk.lines.slice(0, MAX_DIFF_LINES - shown);
						shown += lines.length;
						hunks.push({ ...hunk, lines });
					}
					return {
						path: change.path,
						state:
							change.original === null
								? "added"
								: change.content === null
									? "deleted"
									: "modified",
						...diffStat(change.original, change.content),
						hunks,
						truncated: shown >= MAX_DIFF_LINES,
					};
				}),
			},
		};
	}

	async function ensureSession() {
		if (session) return session;
		const settings = await store.settings();
		const provider = getProvider(settings.provider);
		const [apiKey, githubToken] = await Promise.all([
			store.secret(secretNameFor(provider)),
			store.secret("github_token"),
		]);
		if (
			!settings.owner ||
			!settings.repo ||
			!settings.model ||
			(!apiKey && !provider.keyOptional) ||
			!githubToken
		) {
			throw new HttpError(400, "Setup is incomplete.", { code: "setup" });
		}
		const ai = await createAdapter({
			provider,
			model: settings.model,
			baseUrl: settings.baseUrl,
			apiKey,
		});
		const created = new AssistantSession({
			github: createGitHub(githubToken),
			ai,
			owner: settings.owner,
			repo: settings.repo,
			baseBranch: settings.baseBranch,
			now,
		});
		await created.start();
		session = created;
		return session;
	}

	function requireSession() {
		if (!session) throw new HttpError(400, "There is no session.");
		return session;
	}

	/**
	 * Runs one GitHub-changing step with the session locked.
	 * @param {() => Promise<object|void>} step
	 */
	async function locked(step) {
		if (busy) throw new HttpError(409, "The assistant is busy.");
		busy = true;
		try {
			return (await step()) || {};
		} finally {
			busy = false;
		}
	}

	async function updateConfig(body) {
		const current = await store.settings();
		const next = { ...current, ...pick(body.settings, Object.keys(current)) };
		const provider = getProvider(next.provider);
		if (provider.id !== next.provider) {
			throw new HttpError(400, "Unknown provider.");
		}
		next.baseUrl =
			provider.kind === "openai"
				? String(next.baseUrl || provider.baseUrl).replace(/\/+$/, "")
				: "";
		if (provider.kind === "openai" && !isAllowedBaseUrl(next.baseUrl)) {
			throw new HttpError(
				400,
				"Use an https:// URL (http:// only for localhost).",
				{
					code: "base url",
				},
			);
		}
		for (const key of ["owner", "repo"]) {
			if (next[key] && !NAME.test(next[key])) {
				throw new HttpError(400, `Invalid ${key}.`);
			}
		}
		if (!next.baseBranch || /\s|\.\.|^\/|\/$/.test(next.baseBranch)) {
			throw new HttpError(400, "Invalid base branch.");
		}
		if (!next.model) throw new HttpError(400, "Choose a model.");

		// Conversations are kept in the provider's own format and are tied
		// to one repository and branch.
		const restart = ["provider", "baseUrl", "owner", "repo", "baseBranch"].some(
			(key) => next[key] !== current[key],
		);
		if (restart && hasUnmergedWork() && !body.discard) {
			throw new HttpError(409, "This discards the current session.", {
				code: "discard",
			});
		}

		const secrets = {};
		if (body.apiKey)
			secrets[secretNameFor(provider)] = String(body.apiKey).trim();
		if (body.githubToken)
			secrets.github_token = String(body.githubToken).trim();
		await store.update({ settings: next, secrets });

		if (restart) resetSession();
		else if (session) session.ai.model = next.model;
	}

	async function listModels(body) {
		const provider = getProvider(body.provider);
		const baseUrl = String(body.baseUrl || provider.baseUrl || "").replace(
			/\/+$/,
			"",
		);
		if (provider.kind === "openai" && !isAllowedBaseUrl(baseUrl)) {
			throw new HttpError(
				400,
				"Use an https:// URL (http:// only for localhost).",
				{
					code: "base url",
				},
			);
		}
		const apiKey =
			String(body.apiKey || "").trim() ||
			(await store.secret(secretNameFor(provider)));
		if (!apiKey && !provider.keyOptional) {
			throw new HttpError(400, "Enter the API key first.");
		}
		const adapter = await createAdapter({
			provider,
			model: provider.defaultModel || "",
			baseUrl,
			apiKey,
		});
		return { models: await adapter.listModels() };
	}

	/**
	 * Streams one assistant turn as server-sent events.
	 * @param {import("node:http").ServerResponse} res
	 * @param {{text:string, display?:string}} body
	 */
	async function streamMessage(res, body) {
		const text = String(body.text || "").trim();
		if (!text) throw new HttpError(400, "The message is empty.");
		if (busy) throw new HttpError(409, "The assistant is busy.");
		busy = true;
		try {
			// A merged session is finished; the next request starts a new one.
			if (session?.pr?.merged) resetSession();
			await ensureSession();
		} catch (error) {
			busy = false;
			throw error;
		}

		res.writeHead(200, {
			...SECURITY_HEADERS,
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-store",
			"X-Accel-Buffering": "no",
		});
		const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
		controller = new AbortController();
		const { signal } = controller;
		res.on("close", () => {
			if (!res.writableFinished) controller?.abort();
		});

		const userEntry = addLog({
			kind: "user",
			text: String(body.display || text),
		});
		/**@type {{kind:string, text:string}|null} */
		let reply = null;
		try {
			await session.send(text, {
				signal,
				onEvent(event) {
					if (event.type === "text") {
						reply ??= addLog({ kind: "assistant", text: "" });
						reply.text += event.delta;
					} else if (event.type === "message") {
						reply = null;
					} else if (event.type === "tool") {
						addLog({
							kind: "tool",
							name: event.name,
							label: event.input?.path || event.input?.prefix || "",
							error: event.isError,
						});
					} else if (event.type === "refusal" || event.type === "truncated") {
						addLog({ kind: "note", code: event.type, level: "error" });
					}
					emit(event.type === "message" ? { type: "message" } : event);
				},
			});
		} catch (error) {
			if (error?.userMessageRemoved) log.splice(log.indexOf(userEntry), 1);
			const stopped = signal.aborted;
			addLog(
				stopped
					? { kind: "note", code: "stopped" }
					: {
							kind: "note",
							level: "error",
							text: error?.message || String(error),
						},
			);
			emit({
				type: "error",
				message: stopped ? "stopped" : error?.message || String(error),
				userMessageRemoved: !!error?.userMessageRemoved,
			});
		} finally {
			busy = false;
			controller = null;
			if (!res.destroyed) {
				emit({ type: "done", state: view() });
				res.end();
			}
		}
	}

	/** @type {Record<string, (body:any, res:any) => Promise<object|void>>} */
	const routes = {
		"GET /api/state": async () => ({
			...(await publicSettings()),
			providers: PROVIDERS,
			...view(),
		}),
		"PUT /api/config": async (body) => {
			if (busy) throw new HttpError(409, "The assistant is busy.");
			await updateConfig(body);
			return { ...(await publicSettings()), ...view() };
		},
		"POST /api/models": (body) => listModels(body),
		"POST /api/session/reset": async (body) => {
			if (busy) throw new HttpError(409, "The assistant is busy.");
			if (hasUnmergedWork() && !body.discard) {
				throw new HttpError(409, "This discards the current session.", {
					code: "discard",
				});
			}
			resetSession();
			return view();
		},
		"POST /api/session/stop": async () => {
			controller?.abort();
			return view();
		},
		"POST /api/session/revert": async (body) => {
			if (busy) throw new HttpError(409, "The assistant is busy.");
			requireSession().changeSet.revert(String(body.path || ""));
			return view();
		},
		"POST /api/session/push": (body) =>
			locked(async () => {
				const s = requireSession();
				const message = String(body.message || "").trim();
				if (!message) throw new HttpError(400, "Enter a commit message.");
				const sha = await s.push(message);
				addLog({
					kind: "note",
					level: "success",
					code: "pushed",
					params: { sha: sha.slice(0, 7), branch: s.workBranch },
				});
				if (s.pr) await s.refreshStatus();
				return view();
			}),
		"POST /api/session/pr": (body) =>
			locked(async () => {
				const s = requireSession();
				const title = String(body.title || "").trim();
				if (!title) throw new HttpError(400, "Enter a title.");
				const files = [...s.pushedPaths].map((file) => `- \`${file}\``);
				const pr = await s.openPullRequest({
					title,
					body: `Changes made with the EditorA AI assistant.\n\n${files.join("\n")}`,
				});
				addLog({
					kind: "note",
					level: "success",
					code: "pr opened",
					params: { number: pr.number },
				});
				await s.refreshStatus();
				return view();
			}),
		"POST /api/session/refresh": () =>
			locked(async () => {
				await requireSession().refreshStatus();
				return view();
			}),
		"POST /api/session/merge": (body) =>
			locked(async () => {
				const s = requireSession();
				if (!s.pr) throw new HttpError(400, "There is no pull request.");
				// The user confirmed a specific head; refuse if it changed since.
				if (!body.headSha || body.headSha !== s.pr.head?.sha) {
					throw new HttpError(
						409,
						"The pull request changed. Check it again.",
						{
							code: "head changed",
						},
					);
				}
				try {
					await s.merge();
				} catch (error) {
					if (error.readiness) {
						throw new HttpError(409, error.message, {
							code: "blocked",
							readiness: error.readiness,
						});
					}
					throw error;
				}
				addLog({
					kind: "note",
					level: "success",
					code: "merged",
					params: { number: s.pr.number, branch: s.baseBranch },
				});
				return view();
			}),
		"POST /api/session/sync": () =>
			locked(async () => {
				const s = requireSession();
				const { upToDate, conflicted } = await s.syncWithBase();
				addLog(
					upToDate
						? {
								kind: "note",
								code: "up to date",
								params: { branch: s.baseBranch },
							}
						: {
								kind: "note",
								level: conflicted.length ? "error" : "info",
								code: conflicted.length ? "merging base" : "merging base clean",
								params: { branch: s.baseBranch, paths: conflicted.join(", ") },
							},
				);
				return view();
			}),
		"POST /api/session/abort-merge": async () => {
			if (busy) throw new HttpError(409, "The assistant is busy.");
			const s = requireSession();
			s.abortMerge();
			addLog({
				kind: "note",
				code: "merge aborted",
				params: { branch: s.baseBranch },
			});
			return view();
		},
		"POST /api/session/ci-report": () =>
			locked(async () => ({
				report: await requireSession().ciFailureReport(),
			})),
	};

	/**
	 * @param {import("node:http").IncomingMessage} req
	 * @param {import("node:http").ServerResponse} res
	 */
	async function handle(req, res) {
		const url = new URL(req.url, "http://localhost");
		try {
			if (req.method === "GET" && STATIC_FILES[url.pathname]) {
				const [file, type] = STATIC_FILES[url.pathname];
				const content = await readFile(path.join(WEB_DIR, file));
				res.writeHead(200, {
					...SECURITY_HEADERS,
					"Content-Type": type,
					"Cache-Control": "no-cache",
				});
				res.end(content);
				return;
			}
			if (!url.pathname.startsWith("/api/")) {
				throw new HttpError(404, "Not found.");
			}
			if (!authorized(req)) throw new HttpError(401, "Unauthorized.");

			const body = req.method === "GET" ? {} : await readJson(req);
			if (req.method === "POST" && url.pathname === "/api/session/message") {
				await streamMessage(res, body);
				return;
			}
			const route = routes[`${req.method} ${url.pathname}`];
			if (!route) throw new HttpError(404, "Not found.");
			sendJson(res, 200, await route(body, res));
		} catch (error) {
			if (res.headersSent) {
				res.end();
				return;
			}
			const status = error instanceof HttpError ? error.status : 500;
			sendJson(res, status, {
				error: error?.message || String(error),
				...(error instanceof HttpError ? error.extra : {}),
				...(status >= 400 && url.pathname.startsWith("/api/session")
					? { state: view() }
					: {}),
			});
		}
	}

	return { handle };
}

/**
 * @param {object} source
 * @param {string[]} keys
 */
function pick(source, keys) {
	const out = {};
	for (const key of keys) {
		if (typeof source?.[key] === "string") out[key] = source[key].trim();
	}
	return out;
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
function sendJson(res, status, body) {
	res.writeHead(status, {
		...SECURITY_HEADERS,
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify(body));
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<any>}
 */
async function readJson(req) {
	let size = 0;
	const chunks = [];
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request too large.");
		chunks.push(chunk);
	}
	if (!size) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "Invalid JSON.");
	}
}
