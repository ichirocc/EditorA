import { runAgentTurn } from "./agent";
import ChangeSet from "./changeSet";
import { evaluateMergeReadiness } from "./mergeGate";
import { buildStateNote, buildSystemPrompt } from "./prompt";
import { createToolExecutor } from "./tools";

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
	/**@type {any} */
	#claude;
	/**@type {typeof runAgentTurn} */
	#runTurn;
	/**@type {() => Date} */
	#now;
	/**@type {Map<string, Promise<any>>} */
	#treeCache = new Map();
	/**@type {Map<string, Promise<string|null>>} */
	#fileCache = new Map();
	/**@type {string} */
	#lastStateNote = "";
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
	 * @param {object} options
	 * @param {import("./github").GitHubClient} options.github
	 * @param {any} options.claude Anthropic client
	 * @param {string} options.model
	 * @param {string} options.owner
	 * @param {string} options.repo
	 * @param {string} options.baseBranch
	 * @param {typeof runAgentTurn} [options.runTurn]
	 * @param {() => Date} [options.now]
	 */
	constructor({
		github,
		claude,
		model,
		owner,
		repo,
		baseBranch,
		runTurn = runAgentTurn,
		now = () => new Date(),
	}) {
		this.#github = github;
		this.#claude = claude;
		this.#runTurn = runTurn;
		this.#now = now;
		this.model = model;
		this.owner = owner;
		this.repo = repo;
		this.baseBranch = baseBranch;
		this.system = buildSystemPrompt({ owner, repo, baseBranch });
		this.#executeTool = createToolExecutor({
			changeSet: this.changeSet,
			listBranchFiles: () => this.#listFiles(),
			readBranchFile: (path) => this.#readFile(path),
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
	 * @type {"briefing"|"editing"|"pushed"|"pr"|"merged"}
	 */
	get phase() {
		if (this.pr?.merged) return "merged";
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

		const content = [];
		const note = buildStateNote({
			workBranch: this.workBranch,
			stagedPaths: this.changeSet.list().map((change) => change.path),
			pr: this.pr,
		});
		if (note !== this.#lastStateNote) {
			content.push({ type: "text", text: note });
		}
		content.push({ type: "text", text });

		const before = this.messages.length;
		this.messages.push({ role: "user", content });
		try {
			await this.#runTurn({
				client: this.#claude,
				model: this.model,
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
		if (this.messages.length > before) this.#lastStateNote = note;
	}

	/** First user message, used to prefill commit and pull request titles. */
	get briefTitle() {
		const first = this.messages.find(
			(message) => message.role === "user" && Array.isArray(message.content),
		);
		// The last text block is the user's own words; a state note may precede it.
		const text =
			first?.content.filter((block) => block.type === "text").pop()?.text || "";
		const line = text.split("\n").find((entry) => entry.trim()) || "";
		return line.trim().slice(0, 72);
	}

	/**
	 * Commits all staged edits as one commit on the work branch, creating the
	 * branch from the base head on the first push.
	 * @param {string} message commit message
	 * @returns {Promise<string>} commit sha
	 */
	async push(message) {
		if (!this.changeSet.size) throw new Error("There are no staged changes.");
		if (this.pr?.merged) throw new Error("The pull request is already merged.");

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
			parentSha: this.head.commitSha,
			parentTreeSha: this.head.treeSha,
			message,
			entries: this.changeSet.toTreeEntries(),
		});
		this.head = commit;
		for (const change of this.changeSet.list())
			this.pushedPaths.add(change.path);
		this.changeSet.clear();
		this.readiness = null;
		return commit.commitSha;
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
		if (!pr.merged && pr.head.sha !== this.head.commitSha) {
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

	#readFile(path) {
		const key = `${this.head.commitSha}:${path}`;
		if (!this.#fileCache.has(key)) {
			const request = this.#github.readFile(
				this.owner,
				this.repo,
				path,
				this.head.commitSha,
			);
			request.catch(() => this.#fileCache.delete(key));
			this.#fileCache.set(key, request);
		}
		return this.#fileCache.get(key);
	}
}
