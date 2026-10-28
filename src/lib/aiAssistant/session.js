import ChangeSet from "./changeSet";
import { hasConflictMarkers, merge3 } from "./merge3";
import { evaluateMergeReadiness } from "./mergeGate";
import {
	buildCiFailureReport,
	buildStateNote,
	buildSystemPrompt,
} from "./prompt";
import { createToolExecutor } from "./tools";

// GitHub lists at most 300 changed files in a comparison.
const COMPARE_FILE_LIMIT = 300;
const READ_CONCURRENCY = 6;

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
 * @property {(options:{system:string, messages:any[], executeTool:(name:string, input:any) => Promise<string>, onEvent?:(event:import("./agent").AgentEvent) => void, signal?:AbortSignal}) => Promise<void>} runTurn
 *   streams one turn, appending the assistant's messages and tool results
 */

/**
 * One briefing → edit → push → pull request → merge cycle against a
 * repository branch.
 *
 * The assistant only stages edits. Every step that changes GitHub (creating
 * the work branch, committing, opening the pull request, merging) is a
 * separate method the UI calls on an explicit user action, and `merge()`
 * re-checks the merge gate right before merging the exact head it checked.
 */
export default class AssistantSession {
	/**@type {import("./github").GitHubClient} */
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
	#executeTool;

	/**@type {{commitSha:string, treeSha:string}|null} head the assistant reads from */
	head = null;
	/**@type {string|null} */
	workBranch = null;
	/**@type {any|null} pull request from the GitHub API */
	pr = null;
	/**@type {import("./mergeGate").MergeReadiness|null} */
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
	 * @param {import("./github").GitHubClient} options.github
	 * @param {ModelAdapter} options.ai
	 * @param {string} options.owner
	 * @param {string} options.repo
	 * @param {string} options.baseBranch
	 * @param {() => Date} [options.now]
	 */
	constructor({ github, ai, owner, repo, baseBranch, now = () => new Date() }) {
		this.#github = github;
		this.#now = now;
		this.ai = ai;
		this.owner = owner;
		this.repo = repo;
		this.baseBranch = baseBranch;
		this.system = buildSystemPrompt({ owner, repo, baseBranch });
		this.#executeTool = createToolExecutor({
			changeSet: this.changeSet,
			listBranchFiles: () => this.#listFiles(),
			readBranchFile: (path) => this.#readAt(path, this.head.commitSha),
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
	 * @param {(event:import("./agent").AgentEvent) => void} [options.onEvent]
	 * @param {AbortSignal} [options.signal]
	 */
	async send(text, { onEvent, signal } = {}) {
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
	 * @returns {Promise<import("./mergeGate").MergeReadiness>}
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
		const tip = this.merging?.tip.commitSha ?? this.head.commitSha;
		if (!pr.merged && pr.head.sha !== tip) {
			// Someone else pushed to the branch: the user has not reviewed it.
			readiness.blockers.push({ code: "head changed" });
			readiness.ready = false;
		}
		if (this.changeSet.size) {
			readiness.blockers.push({ code: "unpushed" });
			readiness.ready = false;
		}
		this.readiness = readiness;
		return readiness;
	}

	/**
	 * Squash-merges the pull request after re-checking the gate. GitHub
	 * refuses the merge if the head moved after this check.
	 * @returns {Promise<import("./mergeGate").MergeReadiness>} the readiness
	 *   that allowed the merge
	 */
	async merge() {
		const readiness = await this.refreshStatus();
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
