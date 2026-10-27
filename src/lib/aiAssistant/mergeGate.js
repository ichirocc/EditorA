/**
 * Decides whether a pull request may be merged into the base branch.
 *
 * The app only merges on an explicit user instruction, and even then only
 * when the head it is about to merge has no conflict, is not blocked by
 * branch protection, and every reported CI check has finished successfully.
 */

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * @typedef {"merged"|"closed"|"draft"|"computing"|"conflict"|"protected"|"behind"|"ci failed"|"ci running"|"head changed"|"unpushed"} BlockerCode
 * ("head changed" and "unpushed" are added by AssistantSession.)
 */

/**
 * @typedef {object} MergeReadiness
 * @property {boolean} ready the merge button may be enabled
 * @property {boolean} pending something is still running or being computed
 * @property {{code:BlockerCode, names?:string[]}[]} blockers reasons the merge is refused
 * @property {"no checks"[]} warnings things the user must acknowledge before merging
 * @property {{name:string, state:"success"|"pending"|"failure", summary?:string}[]} checks
 */

/**
 * @param {object} input
 * @param {any} input.pr pull request from `GET /pulls/{number}`
 * @param {any[]} [input.checkRuns] from `GET /commits/{sha}/check-runs`
 * @param {any} [input.combinedStatus] from `GET /commits/{sha}/status`
 * @returns {MergeReadiness}
 */
export function evaluateMergeReadiness({
	pr,
	checkRuns = [],
	combinedStatus = null,
}) {
	/**@type {MergeReadiness["blockers"]} */
	const blockers = [];
	/**@type {MergeReadiness["warnings"]} */
	const warnings = [];
	let pending = false;

	if (pr.merged) {
		blockers.push({ code: "merged" });
	} else if (pr.state !== "open") {
		blockers.push({ code: "closed" });
	}
	if (pr.draft) {
		blockers.push({ code: "draft" });
	}

	if (pr.mergeable === null || pr.mergeable_state === "unknown") {
		pending = true;
		blockers.push({ code: "computing" });
	} else if (pr.mergeable === false || pr.mergeable_state === "dirty") {
		blockers.push({ code: "conflict" });
	} else if (pr.mergeable_state === "blocked") {
		blockers.push({ code: "protected" });
	} else if (pr.mergeable_state === "behind") {
		blockers.push({ code: "behind" });
	}

	/**@type {MergeReadiness["checks"]} */
	const checks = [];
	for (const run of checkRuns) {
		if (run.status !== "completed") {
			checks.push({ name: run.name, state: "pending" });
		} else if (PASSING_CONCLUSIONS.has(run.conclusion)) {
			checks.push({ name: run.name, state: "success" });
		} else {
			const summary = [run.output?.title, run.output?.summary]
				.filter(Boolean)
				.join("\n")
				.slice(0, 2000);
			checks.push({ name: run.name, state: "failure", summary });
		}
	}
	for (const status of combinedStatus?.statuses || []) {
		const state =
			status.state === "success"
				? "success"
				: status.state === "pending"
					? "pending"
					: "failure";
		checks.push({
			name: status.context,
			state,
			summary: state === "failure" ? status.description || "" : undefined,
		});
	}

	const failed = checks.filter((check) => check.state === "failure");
	const running = checks.filter((check) => check.state === "pending");
	if (failed.length) {
		blockers.push({
			code: "ci failed",
			names: failed.map((check) => check.name),
		});
	}
	if (running.length) {
		pending = true;
		blockers.push({
			code: "ci running",
			names: running.map((check) => check.name),
		});
	}
	if (!checks.length) {
		warnings.push("no checks");
	}

	return {
		ready: blockers.length === 0,
		pending,
		blockers,
		warnings,
		checks,
	};
}
