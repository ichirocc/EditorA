import ChangeSet from "./changeSet.js";
import { hasConflictMarkers, merge3 } from "./merge3.js";
import { evaluateMergeReadiness } from "./mergeGate.js";
import {
	buildCiFailureReport,
	buildStateNote,
	buildStatusReport,
	buildSystemPrompt,
} from "./prompt.js";
import { createToolExecutor, ToolInputError } from "./tools.js";

// GitHub lists at most 300 changed files in a comparison.
const COMPARE_FILE_LIMIT = 300;
const READ_CONCURRENCY = 6;
// GitHub registers CI check runs a little after a push. Until this much time
// has passed, "no checks yet" means "CI has not started", not "no CI".
const CI_START_GRACE_MS = 2 * 60_000;
const DECLINED =
	"The user declined this step in the app. Do not try it again unless they ask.";

/**
 * Merges one file's two versions against their common ancestor.
 * @param {string|null} ancestor null if the file did not exist
 * @param {string|null} ours null if deleted on the work branch
 * @param {string|null} theirs null if deleted on the base branch
 * @param {{ours:string, theirs:string}} labels
 * @returns {{content:string|null, conflict:boolean}}
 */
function mergeFile(ancestor, ours, theirs, labels) {
	if (ours === theirs || ancestor === theirs) {
		return { content: ours, conflict: false };
	}
	if (ancestor === ours) return { content: theirs, conflict: false };
	if ([ancestor, ours, theirs].some((text) => text?.includes("\0"))) {
		// Binary files cannot be merged line by line; keep the work branch's.
		return { content: ours, conflict: false };
	}
	const merged = merge3(ancestor ?? "", ours ?? "", theirs ?? "", labels);
	return { content: merged.text, conflict: merged.conflicts > 0 };
}

/**
 * Runs `fn` over `items` with at most `limit` calls in flight.
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item:T) => Promise<void>} fn
 */
async function forEachLimited(items, limit, fn) {
	let next = 0;
	const worker = async () => {
		while (next < items.length) await fn(items[next++]);
	};
	await Promise.all(Array.from({ length: limit }, worker));
}

/**
 * The model side of a session, one per provider (see agent.js and
 * openaiCompatible.js). Messages are kept in the provider's own format.
 * @typedef {object} ModelAdapter
 * @property {string} model can be changed between turns
 * @property {(texts:string[]) => any} userMessage
 * @property {(options:{system:string, messages:any[], executeTool:(name:string, input:any) => Promise<string>, onEvent?:(event:import("./agent.js").AgentEvent) => void, signal?:AbortSignal}) => Promise<void>} runTurn
 *   streams one turn, appending the assistant's messages and tool results
 */

/**
 * A GitHub step the assistant wants to take, shown to the user to approve.
 * @typedef {{action:"push", message:string, branch:string|null, paths:string[]}
 *   | {action:"pr", title:string, body:string, baseBranch:string}
 *   | {action:"merge", number:number, title:string, baseBranch:string, headSha:string, warnings:string[]}} ActionRequest
 */

/**
 * Asks the user to approve a step; resolves true to go ahead.
 * @typedef {(request:ActionRequest) => Promise<boolean>} ConfirmAction
 */

/**
 * One briefing → edit → push → pull request → merge cycle against a
 * repository branch.
 *
 * The assistant stages edits. Every step that changes GitHub (creating the
 * work branch, committing, opening the pull request, merging) is a method
 * the UI calls on an explicit user action, or a tool the assistant calls
 * when the user asks in the chat; the tool asks the host to confirm with
 * the user first. `merge()` re-checks the merge gate right before merging
 * the exact head it checked.
 */
export default class AssistantSession {
	/**@type {import("./github.js").GitHubClient} */
	#github;
	/**@type {() => Date} */
	#now;
	/**@type {Map<string, Promise<any>>} */
	#treeCache = new Map();
	/**@type {Map<string, Promise<string|null>>} */
	#fileCache = new Map();
	/**@type {string} */
	#lastStateNote = "";
	/**@type {string} the user's first message */
	#brief = "";
	/**@type {Set<string>} every commit this session pushed */
	#pushedCommits = new Set();
	/**@type {number} when the last push happened (ms) */
	#pushedAt = 0;
	#executeTool;
	/**@type {ConfirmAction|null} approval for the turn that is running */
	#confirm = null;

	/**@type {{commitSha:string, treeSha:string}|null} head the assistant reads from */
	head = null;
	/**@type {string|null} */
	workBranch = null;
	/**@type {any|null} pull request from the GitHub API */
	pr = null;
	/**@type {import("./mergeGate.js").MergeReadiness|null} */
	readiness = null;
	/**@type {any[]} conversation sent to Claude */
	messages = [];
	changeSet = new ChangeSet();
	/**@type {Set<string>} files committed to the work branch so far */
	pushedPaths = new Set();
	/**
	 * Base branch being merged into the work branch. While set, `head` is the
	 * base branch head, staged changes are relative to it, and the next push
	 * creates a merge commit on top of `tip`.
	 * @type {{tip:{commitSha:string, treeSha:string}, baseSha:string, conflicted:string[]}|null}
	 */
	merging = null;

	/**
	 * @param {object} options
	 * @param {import("./github.js").GitHubClient} options.github
	 * @param {ModelAdapter} options.ai
	 * @param {string} options.owner
	 * @param {string} options.repo
	 * @param {string} options.baseBranch
	 * @param {string} [options.host] the app the assistant runs in, for the
	 *   system prompt
	 * @param {() => Date} [options.now]
	 */
	constructor({
		github,
		ai,
		owner,
		repo,
		baseBranch,
		host,
		now = () => new Date(),
	}) {
		this.#github = github;
		this.#now = now;
		this.ai = ai;
		this.owner = owner;
		this.repo = repo;
		this.baseBranch = baseBranch;
		this.system = buildSystemPrompt({ owner, repo, baseBranch, host });
		this.#executeTool = createToolExecutor({
			changeSet: this.changeSet,
			listBranchFiles: () => this.#listFiles(),
			readBranchFile: (path) => this.#readAt(path, this.head.commitSha),
			actions: {
				push_changes: (input) => this.#pushTool(input),
				open_pull_request: (input) => this.#pullRequestTool(input),
				get_pull_request_status: () => this.#statusTool(),
				merge_pull_request: () => this.#mergeTool(),
			},
		});
	}

	/** Loads the head of the base branch. */
	async start() {
		this.head = await this.#github.getBranchHead(
			this.owner,
			this.repo,
			this.baseBranch,
		);
	}

	/**
	 * @type {"briefing"|"editing"|"pushed"|"pr"|"merging"|"merged"}
	 */
	get phase() {
		if (this.pr?.merged) return "merged";
		if (this.merging) return "merging";
		if (this.pr) return "pr";
		if (this.changeSet.size) return "editing";
		if (this.workBranch) return "pushed";
		return "briefing";
	}

	/**
	 * Sends a user message and runs the assistant until it ends its turn.
	 * If the request fails before the assistant replied, the user message is
	 * removed again so it can be resent without duplicating it.
	 * @param {string} text
	 * @param {object} [options]
	 * @param {(event:import("./agent.js").AgentEvent) => void} [options.onEvent]
	 * @param {AbortSignal} [options.signal]
	 * @param {ConfirmAction} [options.confirm] asks the user before a GitHub
	 *   step the assistant takes; without it, the assistant cannot take any
	 */
	async send(text, { onEvent, signal, confirm } = {}) {
		if (!this.head) throw new Error("Session has not started.");
		if (this.pr?.merged) {
			throw new Error("This session is merged. Start a new session.");
		}

		const texts = [];
		const note = buildStateNote({
			workBranch: this.workBranch,
			stagedPaths: this.changeSet.list().map((change) => change.path),
			pr: this.pr,
			merge: this.merging
				? {
						baseBranch: this.baseBranch,
						conflicted: this.unresolvedConflicts,
					}
				: null,
		});
		if (note !== this.#lastStateNote) texts.push(note);
		texts.push(text);

		const before = this.messages.length;
		this.messages.push(this.ai.userMessage(texts));
		this.#confirm = confirm || null;
		try {
			await this.ai.runTurn({
				system: this.system,
				messages: this.messages,
				executeTool: this.#executeTool,
				onEvent,
				signal,
			});
		} catch (error) {
			if (this.messages.length === before + 1) {
				this.messages.pop();
				error.userMessageRemoved = true;
			}
			throw error;
		} finally {
			this.#confirm = null;
		}
		if (this.messages.length > before) {
			this.#lastStateNote = note;
			this.#brief ||= text;
		}
	}

	/** First user message, used to prefill commit and pull request titles. */
	get briefTitle() {
		const line = this.#brief.split("\n").find((entry) => entry.trim()) || "";
		return line.trim().slice(0, 72);
	}

	/** Files the base branch merge left with conflict markers. */
	get unresolvedConflicts() {
		if (!this.merging) return [];
		return this.merging.conflicted.filter((path) =>
			hasConflictMarkers(this.changeSet.get(path)?.content ?? null),
		);
	}

	/** Commit message for the pending base branch merge. */
	get mergeMessage() {
		return `Merge branch '${this.baseBranch}' into ${this.workBranch}`;
	}

	/**
	 * Commits all staged edits as one commit on the work branch, creating the
	 * branch from the base head on the first push. While merging the base
	 * branch, the commit is a merge commit and conflicts must be resolved.
	 * @param {string} message commit message
	 * @returns {Promise<string>} commit sha
	 */
	async push(message) {
		if (!this.changeSet.size && !this.merging) {
			throw new Error("There are no staged changes.");
		}
		if (this.pr?.merged) throw new Error("The pull request is already merged.");
		const conflicts = this.unresolvedConflicts;
		if (conflicts.length) {
			const error = new Error(
				`Resolve the conflicts first: ${conflicts.join(", ")}`,
			);
			error.conflicts = conflicts;
			throw error;
		}

		if (!this.workBranch) {
			const branch = this.#branchName();
			await this.#github.createBranch(
				this.owner,
				this.repo,
				branch,
				this.head.commitSha,
			);
			this.workBranch = branch;
		}

		const commit = await this.#github.commitToBranch(this.owner, this.repo, {
			branch: this.workBranch,
			parents: this.merging
				? [this.merging.tip.commitSha, this.head.commitSha]
				: [this.head.commitSha],
			baseTreeSha: this.head.treeSha,
			message,
			entries: this.changeSet.toTreeEntries(),
		});
		this.head = commit;
		this.#pushedCommits.add(commit.commitSha);
		this.#pushedAt = this.#now().getTime();
		if (!this.merging) {
			for (const change of this.changeSet.list()) {
				this.pushedPaths.add(change.path);
			}
		}
		this.merging = null;
		this.changeSet.clear();
		this.readiness = null;
		return commit.commitSha;
	}

	/**
	 * Merges the latest base branch into the work branch inside the app, to
	 * fix a pull request that conflicts with or is behind the base branch.
	 * Files only one side changed merge cleanly; files both sides changed on
	 * the same lines get conflict markers for the assistant or the user to
	 * resolve. The result is staged and committed by the next push.
	 * @returns {Promise<{upToDate:boolean, conflicted:string[]}>}
	 */
	async syncWithBase() {
		if (!this.workBranch) throw new Error("Push the changes first.");
		if (this.merging) throw new Error("A merge is already in progress.");
		if (this.changeSet.size) throw new Error("Push the staged changes first.");
		if (this.pr?.merged) throw new Error("The pull request is already merged.");

		const { owner, repo } = this;
		const github = this.#github;
		const tip = this.head;
		const base = await github.getBranchHead(owner, repo, this.baseBranch);
		const ours = await github.compare(
			owner,
			repo,
			base.commitSha,
			tip.commitSha,
		);
		if (ours.behind_by === 0) return { upToDate: true, conflicted: [] };

		const mergeBase = ours.merge_base_commit.sha;
		const oursFiles = ours.files || [];
		if (oursFiles.length >= COMPARE_FILE_LIMIT) {
			throw new Error("Too many changed files to merge in the app.");
		}
		const theirs = await github.compare(owner, repo, mergeBase, base.commitSha);
		const theirsFiles = theirs.files || [];
		const touchedOnBase = new Set(
			theirsFiles.flatMap((file) => [file.filename, file.previous_filename]),
		);
		// A truncated list cannot rule a file out, so merge every file then.
		const baseListComplete = theirsFiles.length < COMPARE_FILE_LIMIT;

		/**@type {Map<string, boolean>} path → deleted on the work branch */
		const paths = new Map();
		for (const file of oursFiles) {
			if (file.status === "renamed" && file.previous_filename) {
				paths.set(file.previous_filename, true);
			}
			paths.set(file.filename, file.status === "removed");
		}

		const { files: tipFiles } = await github.listFiles(
			owner,
			repo,
			tip.treeSha,
		);
		const modes = new Map(tipFiles.map((file) => [file.path, file.mode]));
		const labels = { ours: this.workBranch, theirs: this.baseBranch };
		const staged = new ChangeSet();
		const conflicted = [];

		await forEachLimited([...paths], READ_CONCURRENCY, async ([path, gone]) => {
			const [mine, baseText] = await Promise.all([
				gone ? null : this.#readAt(path, tip.commitSha),
				this.#readAt(path, base.commitSha),
			]);
			let content = mine;
			if (!baseListComplete || touchedOnBase.has(path)) {
				const ancestor = await this.#readAt(path, mergeBase);
				const merged = mergeFile(ancestor, mine, baseText, labels);
				content = merged.content;
				if (merged.conflict) conflicted.push(path);
			}
			if (content === null) {
				if (baseText !== null) staged.delete(path, baseText);
			} else {
				staged.write(path, baseText, content, modes.get(path));
			}
		});

		// Only commit to the new state once every read succeeded.
		for (const change of staged.list()) {
			if (change.content === null) {
				this.changeSet.delete(change.path, change.original, change.mode);
			} else {
				this.changeSet.write(
					change.path,
					change.original,
					change.content,
					change.mode,
				);
			}
		}
		this.merging = {
			tip,
			baseSha: base.commitSha,
			conflicted: conflicted.sort(),
		};
		this.head = base;
		this.readiness = null;
		return { upToDate: false, conflicted: this.merging.conflicted };
	}

	/** Drops a base branch merge that has not been pushed. */
	abortMerge() {
		if (!this.merging) return;
		this.head = this.merging.tip;
		this.merging = null;
		this.changeSet.clear();
		this.readiness = null;
	}

	/**
	 * A report on the failed checks of the last status refresh for the
	 * assistant: summaries, annotations and, for GitHub Actions jobs, the end
	 * of the log. Details GitHub does not provide are left out.
	 * @param {number} [limit=3] failed checks to describe
	 * @returns {Promise<string>}
	 */
	async ciFailureReport(limit = 3) {
		const { owner, repo } = this;
		const failed = (this.readiness?.checks || [])
			.filter((check) => check.state === "failure")
			.slice(0, limit);
		const details = await Promise.all(
			failed.map(async (check) => ({
				name: check.name,
				summary: check.summary || "",
				annotations: check.checkRunId
					? await this.#github
							.listCheckRunAnnotations(owner, repo, check.checkRunId)
							.catch(() => [])
					: [],
				log: check.actions
					? await this.#github
							.getJobLogTail(owner, repo, check.checkRunId)
							.catch(() => null)
					: null,
			})),
		);
		return buildCiFailureReport(details);
	}

	/**
	 * @param {{title:string, body?:string}} pr
	 */
	async openPullRequest({ title, body = "" }) {
		if (!this.workBranch) throw new Error("Push the changes first.");
		if (this.changeSet.size) {
			throw new Error("Push the staged changes before opening a pull request.");
		}
		this.pr = await this.#github.createPullRequest(this.owner, this.repo, {
			title,
			head: this.workBranch,
			base: this.baseBranch,
			body,
		});
		this.readiness = null;
		return this.pr;
	}

	/**
	 * Reloads the pull request and its CI results and re-evaluates the gate.
	 * @returns {Promise<import("./mergeGate.js").MergeReadiness>}
	 */
	async refreshStatus() {
		if (!this.pr) throw new Error("There is no pull request.");
		const pr = await this.#github.getPullRequest(
			this.owner,
			this.repo,
			this.pr.number,
		);
		const [checkRuns, combinedStatus] = await Promise.all([
			this.#github.listCheckRuns(this.owner, this.repo, pr.head.sha),
			this.#github.getCombinedStatus(this.owner, this.repo, pr.head.sha),
		]);
		this.pr = pr;
		const readiness = evaluateMergeReadiness({ pr, checkRuns, combinedStatus });
		const block = (code) => {
			readiness.blockers.push({ code });
			readiness.ready = false;
		};
		const tip = this.merging?.tip.commitSha ?? this.head.commitSha;
		if (!pr.merged && pr.head.sha !== tip) {
			if (this.#pushedCommits.has(pr.head.sha)) {
				// An earlier push of ours: GitHub has not caught up yet.
				readiness.pending = true;
				block("computing");
			} else {
				// Someone else pushed to the branch: the user has not reviewed it.
				block("head changed");
			}
		}
		if (
			!pr.merged &&
			!readiness.checks.length &&
			this.#now().getTime() - this.#pushedAt < CI_START_GRACE_MS
		) {
			// CI usually reports within seconds of a push; wait for it.
			readiness.pending = true;
			readiness.warnings = readiness.warnings.filter((w) => w !== "no checks");
			block("ci starting");
		}
		if (this.changeSet.size || this.merging) block("unpushed");
		this.readiness = readiness;
		return readiness;
	}

	/**
	 * Squash-merges the pull request after re-checking the gate. GitHub
	 * refuses the merge if the head moved after this check.
	 * @param {object} [options]
	 * @param {string} [options.headSha] the head the user approved; the merge
	 *   is refused if the pull request moved on since
	 * @returns {Promise<import("./mergeGate.js").MergeReadiness>} the readiness
	 *   that allowed the merge
	 */
	async merge({ headSha } = {}) {
		const readiness = await this.refreshStatus();
		if (headSha && this.pr.head.sha !== headSha) {
			readiness.blockers.push({ code: "head changed" });
			readiness.ready = false;
		}
		if (!readiness.ready) {
			const error = new Error("The pull request cannot be merged yet.");
			error.readiness = readiness;
			throw error;
		}
		await this.#github.mergePullRequest(this.owner, this.repo, this.pr.number, {
			sha: this.pr.head.sha,
			merge_method: "squash",
			commit_title: `${this.pr.title} (#${this.pr.number})`,
		});
		this.pr = await this.#github.getPullRequest(
			this.owner,
			this.repo,
			this.pr.number,
		);
		return readiness;
	}

	/**
	 * Asks the host to confirm a step with the user.
	 * @param {ActionRequest} request
	 */
	async #approved(request) {
		if (!this.#confirm) return false;
		return !!(await this.#confirm(request));
	}

	async #pushTool({ message }) {
		if (!this.changeSet.size && !this.merging) {
			return this.workBranch
				? `Nothing is staged; everything is already pushed to ${this.workBranch}.`
				: "Nothing is staged, so there is nothing to push.";
		}
		const conflicts = this.unresolvedConflicts;
		if (conflicts.length) {
			throw new ToolInputError(
				`Resolve the conflict markers first: ${conflicts.join(", ")}`,
			);
		}
		const text =
			message.trim() ||
			(this.merging ? this.mergeMessage : this.briefTitle) ||
			"Update files";
		const approved = await this.#approved({
			action: "push",
			message: text,
			branch: this.workBranch,
			paths: this.changeSet.list().map((change) => change.path),
		});
		if (!approved) return DECLINED;
		const sha = await this.push(text);
		if (!this.pr) {
			return `Pushed commit ${sha.slice(0, 7)} to ${this.workBranch}. There is no pull request yet.`;
		}
		// Shows "waiting for CI" so the app keeps checking.
		await this.refreshStatus().catch(() => {});
		return `Pushed commit ${sha.slice(0, 7)} to ${this.workBranch}; pull request #${this.pr.number} now includes it and CI runs again.`;
	}

	async #pullRequestTool({ title, body = "" }) {
		if (this.pr) {
			return `Pull request #${this.pr.number} already exists (${this.pr.merged ? "merged" : this.pr.state}).`;
		}
		if (!this.workBranch || this.changeSet.size || this.merging) {
			throw new ToolInputError(
				"Push the staged edits first (push_changes), then open the pull request.",
			);
		}
		const trimmed = title.trim() || this.briefTitle;
		if (!trimmed) throw new ToolInputError("The title must not be empty.");
		const approved = await this.#approved({
			action: "pr",
			title: trimmed,
			body,
			baseBranch: this.baseBranch,
		});
		if (!approved) return DECLINED;
		const pr = await this.openPullRequest({ title: trimmed, body });
		await this.refreshStatus().catch(() => {});
		return `Opened pull request #${pr.number}: ${pr.html_url}`;
	}

	async #statusTool() {
		if (!this.pr) {
			return this.workBranch
				? "There is no pull request yet."
				: "Nothing is pushed and there is no pull request yet.";
		}
		return buildStatusReport(this.pr, await this.refreshStatus());
	}

	async #mergeTool() {
		if (!this.pr) {
			throw new ToolInputError(
				"There is no pull request to merge. Push and open one first.",
			);
		}
		if (this.pr.merged) return `Pull request #${this.pr.number} is merged.`;
		const readiness = await this.refreshStatus();
		if (!readiness.ready) {
			return `Not merged. ${buildStatusReport(this.pr, readiness)}`;
		}
		const { number, title } = this.pr;
		const headSha = this.pr.head.sha;
		const approved = await this.#approved({
			action: "merge",
			number,
			title,
			baseBranch: this.baseBranch,
			headSha,
			warnings: readiness.warnings,
		});
		if (!approved) return DECLINED;
		try {
			await this.merge({ headSha });
		} catch (error) {
			if (!error.readiness) throw error;
			return `Not merged. ${buildStatusReport(this.pr, error.readiness)}`;
		}
		return `Merged pull request #${number} into ${this.baseBranch}.`;
	}

	#branchName() {
		const stamp = this.#now()
			.toISOString()
			.replace(/[-:]/g, "")
			.replace("T", "-")
			.slice(0, 15);
		return `ai/edit-${stamp}`;
	}

	#listFiles() {
		const { treeSha } = this.head;
		if (!this.#treeCache.has(treeSha)) {
			const request = this.#github.listFiles(this.owner, this.repo, treeSha);
			request.catch(() => this.#treeCache.delete(treeSha));
			this.#treeCache.set(treeSha, request);
		}
		return this.#treeCache.get(treeSha);
	}

	/**
	 * File content at a commit (cached; commits never change).
	 * @param {string} path
	 * @param {string} commitSha
	 * @returns {Promise<string|null>}
	 */
	#readAt(path, commitSha) {
		const key = `${commitSha}:${path}`;
		if (!this.#fileCache.has(key)) {
			const request = this.#github.readFile(
				this.owner,
				this.repo,
				path,
				commitSha,
			);
			request.catch(() => this.#fileCache.delete(key));
			this.#fileCache.set(key, request);
		}
		return this.#fileCache.get(key);
	}
}
