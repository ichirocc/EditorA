import { describe, expect, it, vi } from "vitest";
import AssistantSession, { MAX_AUTO_FIXES } from "../core/session.js";

const PASSED = [{ name: "build", status: "completed", conclusion: "success" }];

/**
 * GitHub with one pull request whose head follows every push. CI has
 * reported nothing on a commit until the test sets its result.
 */
function fakeGitHub() {
	let pr = null;
	let commits = 0;
	const github = {
		/**@type {Record<string, any[]>} check runs by commit */
		ci: {},
		/**@type {any[]} check runs of a commit not in `ci` */
		ciElse: [],
		getBranchHead: vi.fn(async () => ({ commitSha: "base", treeSha: "tree0" })),
		listFiles: vi.fn(async () => ({
			files: [{ path: "a.js", mode: "100644" }],
			truncated: false,
		})),
		readFile: vi.fn(async (_o, _r, path) => (path === "a.js" ? "one\n" : null)),
		createBranch: vi.fn(async () => ({})),
		commitToBranch: vi.fn(async () => {
			commits++;
			if (pr) pr = { ...pr, head: { sha: `c${commits}` } };
			return { commitSha: `c${commits}`, treeSha: `tree${commits}` };
		}),
		createPullRequest: vi.fn(async (_o, _r, request) => {
			pr = {
				number: 5,
				title: request.title,
				state: "open",
				merged: false,
				draft: false,
				mergeable: true,
				mergeable_state: "clean",
				html_url: "https://github.com/o/r/pull/5",
				head: { sha: `c${commits}` },
			};
			return pr;
		}),
		getPullRequest: vi.fn(async () => ({ ...pr })),
		listCheckRuns: vi.fn(
			async (_o, _r, sha) => github.ci[sha] ?? github.ciElse,
		),
		getCombinedStatus: vi.fn(async () => ({ statuses: [] })),
		listCheckRunAnnotations: vi.fn(async () => []),
		getJobLogTail: vi.fn(async () => null),
		mergePullRequest: vi.fn(async () => {
			pr = { ...pr, state: "closed", merged: true };
			return { merged: true };
		}),
	};
	return github;
}

const FAILED = [
	{
		id: 9,
		name: "build",
		status: "completed",
		conclusion: "failure",
		output: { title: "1 test failed" },
	},
];
const RUNNING = [{ name: "build", status: "in_progress" }];

/**
 * A session with an open pull request whose CI passed. Each turn, the model
 * edits a.js and calls the tools queued in `calls`.
 */
async function sessionWithPullRequest(github) {
	const calls = [];
	let edits = 0;
	const ai = {
		model: "m",
		userMessage: (texts) => ({ role: "user", content: texts.join("\n") }),
		async runTurn({ messages, executeTool }) {
			edits++;
			await executeTool("write_file", {
				path: "a.js",
				content: `edit ${edits}\n`,
			});
			for (const [name, input] of calls.splice(0)) {
				await executeTool(name, input).catch(() => {});
			}
			messages.push({ role: "assistant", content: "ok" });
		},
	};
	const clock = { now: new Date("2026-10-29T01:02:03Z") };
	const session = new AssistantSession({
		github,
		ai,
		owner: "o",
		repo: "r",
		baseBranch: "main",
		now: () => clock.now,
	});
	await session.start();
	await session.send("Change a.js");
	await session.push("Change a.js");
	await session.openPullRequest({ title: "Change a.js" });
	/** Reports CI on the pull request's head, and refreshes the session. */
	const ci = (checks) => {
		github.ci[session.pr.head.sha] = checks;
		return session.refreshStatus();
	};
	await ci(PASSED);
	return { session, calls, ci, clock };
}

describe("steps the app takes by itself for a pull request", () => {
	it("takes none until the user turns them on", async () => {
		const github = fakeGitHub();
		const { session, ci } = await sessionWithPullRequest(github);
		expect(session.autopilot).toEqual({ fix: false, merge: false, fixes: 0 });
		expect(session.nextAutopilotStep()).toBeNull();

		await ci(FAILED);
		expect(session.nextAutopilotStep()).toBeNull();
		await expect(session.send("Fix CI", { autoFix: true })).rejects.toThrow(
			"There is no failed CI run",
		);
	});

	it("fixes failed CI and pushes without asking, then gives up after the limit", async () => {
		const github = fakeGitHub();
		const { session, calls, ci } = await sessionWithPullRequest(github);
		session.setAutopilot({ fix: true });
		const confirm = vi.fn(async () => false);

		for (let fix = 1; fix <= MAX_AUTO_FIXES; fix++) {
			await ci(FAILED);
			expect(session.nextAutopilotStep()).toBe("fix");
			const head = session.pr.head.sha;
			calls.push(["push_changes", { message: `Fix CI ${fix}` }]);
			await session.send("CI failed. Fix it and push.", {
				autoFix: true,
				confirm,
			});
			expect(session.autopilot.fixes).toBe(fix);
			expect(session.pr.head.sha).not.toBe(head);
			// The pushed fix waits for CI before anything else happens.
			expect(session.readiness.pending).toBe(true);
			expect(session.nextAutopilotStep()).toBeNull();
		}
		expect(confirm).not.toHaveBeenCalled();

		await ci(FAILED);
		expect(session.nextAutopilotStep()).toBe("give up");
		session.setAutopilot({ fix: false });
		expect(session.nextAutopilotStep()).toBeNull();
		// Turned on again, the count starts over.
		session.setAutopilot({ fix: true });
		expect(session.nextAutopilotStep()).toBe("fix");
	});

	it("sends a failed head to be fixed once, and counts again after CI passes", async () => {
		const github = fakeGitHub();
		const { session, ci } = await sessionWithPullRequest(github);
		session.setAutopilot({ fix: true });
		await ci(FAILED);

		// The model edits but does not push: the head stays the failed one.
		await session.send("CI failed. Fix it and push.", { autoFix: true });
		expect(session.autopilot.fixes).toBe(1);
		await session.refreshStatus();
		expect(session.changeSet.size).toBe(1);
		expect(session.nextAutopilotStep()).toBeNull();
		session.changeSet.clear();
		await session.refreshStatus();
		expect(session.nextAutopilotStep()).toBeNull();

		await ci(PASSED);
		expect(session.autopilot.fixes).toBe(0);
	});

	it("still asks before any other step in an automatic fix", async () => {
		const github = fakeGitHub();
		const { session, calls, ci } = await sessionWithPullRequest(github);
		session.setAutopilot({ fix: true });
		await ci(FAILED);
		github.ciElse = PASSED;
		const confirm = vi.fn(async () => false);
		calls.push(
			["push_changes", { message: "Fix CI" }],
			["merge_pull_request", {}],
		);

		await session.send("CI failed. Fix it and push.", {
			autoFix: true,
			confirm,
		});
		expect(confirm.mock.calls.map(([request]) => request.action)).toEqual([
			"merge",
		]);
		expect(github.mergePullRequest).not.toHaveBeenCalled();
	});

	it("asks before pushing a fix once the user turned fixing off", async () => {
		const github = fakeGitHub();
		const { session, calls, ci } = await sessionWithPullRequest(github);
		session.setAutopilot({ fix: true });
		await ci(FAILED);
		const pushes = github.commitToBranch.mock.calls.length;
		const confirm = vi.fn(async () => false);
		calls.push(["push_changes", { message: "Fix CI" }]);
		const { runTurn } = session.ai;
		session.ai.runTurn = (options) => {
			session.setAutopilot({ fix: false });
			return runTurn(options);
		};

		await session.send("CI failed. Fix it and push.", {
			autoFix: true,
			confirm,
		});
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(github.commitToBranch).toHaveBeenCalledTimes(pushes);
	});

	it("merges only once CI has passed and nothing blocks the merge", async () => {
		const github = fakeGitHub();
		const { session, ci, clock } = await sessionWithPullRequest(github);
		session.setAutopilot({ merge: true });
		expect(session.nextAutopilotStep()).toBe("merge");

		await ci(RUNNING);
		expect(session.nextAutopilotStep()).toBeNull();
		await ci(FAILED);
		expect(session.nextAutopilotStep()).toBeNull();

		// Without CI, nothing says the change works.
		clock.now = new Date("2026-10-29T02:00:00Z");
		await ci([]);
		expect(session.readiness).toMatchObject({
			ready: true,
			warnings: ["no checks"],
		});
		expect(session.nextAutopilotStep()).toBeNull();

		// Unpushed work is not what CI checked.
		await ci(PASSED);
		session.changeSet.write("a.js", "edit 1\n", "local\n");
		await session.refreshStatus();
		expect(session.nextAutopilotStep()).toBeNull();
		session.changeSet.clear();
		await session.refreshStatus();
		expect(session.nextAutopilotStep()).toBe("merge");

		await session.merge({ headSha: session.pr.head.sha });
		expect(github.mergePullRequest).toHaveBeenCalledTimes(1);
		expect(session.nextAutopilotStep()).toBeNull();
	});

	it("stops once someone else pushed to the branch", async () => {
		const github = fakeGitHub();
		const { session } = await sessionWithPullRequest(github);
		session.setAutopilot({ fix: true, merge: true });
		const theirs = { ...session.pr, head: { sha: "theirs" } };
		github.getPullRequest.mockImplementation(async () => ({ ...theirs }));

		github.ci.theirs = FAILED;
		await session.refreshStatus();
		expect(session.nextAutopilotStep()).toBeNull();
		github.ci.theirs = PASSED;
		await session.refreshStatus();
		expect(session.nextAutopilotStep()).toBeNull();
	});

	it("needs an open pull request to be turned on", async () => {
		const github = fakeGitHub();
		const session = new AssistantSession({
			github,
			ai: { model: "m", userMessage: () => ({}), runTurn: async () => {} },
			owner: "o",
			repo: "r",
			baseBranch: "main",
		});
		await session.start();
		expect(() => session.setAutopilot({ merge: true })).toThrow(
			"There is no open pull request.",
		);
	});
});
