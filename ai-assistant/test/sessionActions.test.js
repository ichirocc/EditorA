import { describe, expect, it, vi } from "vitest";
import AssistantSession from "../core/session.js";

function fakeGitHub() {
	let pr = null;
	return {
		getBranchHead: vi.fn(async () => ({ commitSha: "base", treeSha: "tree0" })),
		listFiles: vi.fn(async () => ({
			files: [{ path: "a.js", mode: "100644" }],
			truncated: false,
		})),
		readFile: vi.fn(async (_o, _r, path) => (path === "a.js" ? "one\n" : null)),
		createBranch: vi.fn(async () => ({})),
		commitToBranch: vi.fn(async () => ({ commitSha: "c1", treeSha: "tree1" })),
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
				head: { sha: "c1" },
			};
			return pr;
		}),
		getPullRequest: vi.fn(async () => ({ ...pr })),
		listCheckRuns: vi.fn(async () => [
			{ name: "build", status: "completed", conclusion: "success" },
		]),
		getCombinedStatus: vi.fn(async () => ({ statuses: [] })),
		mergePullRequest: vi.fn(async () => {
			pr = { ...pr, state: "closed", merged: true };
			return { merged: true };
		}),
	};
}

/**
 * A session whose model edits a.js, then calls the given tools in order;
 * `results` collects what each tool returned (or its error).
 */
async function chatSession(github, calls) {
	const results = [];
	const ai = {
		model: "m",
		userMessage: (texts) => ({ role: "user", content: texts.join("\n") }),
		async runTurn({ messages, executeTool }) {
			for (const [name, input] of calls.splice(0)) {
				try {
					results.push(await executeTool(name, input));
				} catch (error) {
					results.push(`error: ${error.message}`);
				}
			}
			messages.push({ role: "assistant", content: "ok" });
		},
	};
	const session = new AssistantSession({
		github,
		ai,
		owner: "o",
		repo: "r",
		baseBranch: "main",
		now: () => new Date("2026-10-29T01:02:03Z"),
	});
	await session.start();
	return { session, results };
}

const EDIT = [
	"edit_file",
	{ path: "a.js", old_string: "one", new_string: "two" },
];

describe("GitHub steps the assistant takes on request", () => {
	it("pushes, opens a pull request and merges, each after the user confirms", async () => {
		const github = fakeGitHub();
		const { session, results } = await chatSession(github, [
			EDIT,
			["push_changes", { message: "Change one to two" }],
			["open_pull_request", { title: "Fix", body: "Changes one." }],
			["merge_pull_request", {}],
		]);
		const confirm = vi.fn(async () => true);

		await session.send("Change one to two, open a PR and merge it", {
			confirm,
		});

		expect(confirm.mock.calls.map(([request]) => request)).toEqual([
			{
				action: "push",
				message: "Change one to two",
				branch: null,
				paths: ["a.js"],
			},
			{ action: "pr", title: "Fix", body: "Changes one.", baseBranch: "main" },
			{
				action: "merge",
				number: 5,
				title: "Fix",
				baseBranch: "main",
				headSha: "c1",
				warnings: [],
			},
		]);
		expect(results.slice(1)).toEqual([
			"Pushed commit c1 to ai/edit-20261029-010203. There is no pull request yet.",
			"Opened pull request #5: https://github.com/o/r/pull/5",
			"Merged pull request #5 into main.",
		]);
		expect(github.mergePullRequest).toHaveBeenCalledWith("o", "r", 5, {
			sha: "c1",
			merge_method: "squash",
			commit_title: "Fix (#5)",
		});
		expect(session.phase).toBe("merged");
	});

	it("changes nothing on GitHub when the user declines", async () => {
		const github = fakeGitHub();
		const { session, results } = await chatSession(github, [
			EDIT,
			["push_changes", { message: "Change" }],
		]);

		await session.send("Push it", { confirm: async () => false });

		expect(results[1]).toMatch(/^The user declined/);
		expect(github.createBranch).not.toHaveBeenCalled();
		expect(github.commitToBranch).not.toHaveBeenCalled();
		expect(session.changeSet.size).toBe(1);
	});

	it("declines every step when the app cannot ask the user", async () => {
		const github = fakeGitHub();
		const { session, results } = await chatSession(github, [
			EDIT,
			["push_changes", { message: "Change" }],
		]);

		await session.send("Push it");

		expect(results[1]).toMatch(/^The user declined/);
		expect(github.commitToBranch).not.toHaveBeenCalled();
	});

	it("reports what blocks a merge without asking the user", async () => {
		const github = fakeGitHub();
		const { session, results } = await chatSession(github, [
			EDIT,
			["push_changes", { message: "Change" }],
			["open_pull_request", { title: "Fix" }],
		]);
		await session.send("Open a PR", { confirm: async () => true });
		github.listCheckRuns.mockResolvedValue([
			{ name: "build", status: "completed", conclusion: "failure" },
		]);
		const confirm = vi.fn(async () => true);

		session.ai.runTurn = async ({ messages, executeTool }) => {
			results.push(await executeTool("merge_pull_request", {}));
			results.push(await executeTool("get_pull_request_status", {}));
			messages.push({ role: "assistant", content: "ok" });
		};
		await session.send("Merge it", { confirm });

		expect(confirm).not.toHaveBeenCalled();
		expect(github.mergePullRequest).not.toHaveBeenCalled();
		expect(results.at(-2)).toContain("Not merged.");
		expect(results.at(-1)).toBe(
			[
				"Pull request #5 (open): Fix",
				"https://github.com/o/r/pull/5",
				"Checks: build: failure",
				"Blocking the merge: ci failed (build)",
				"Ready to merge: no",
			].join("\n"),
		);
	});

	it("does not merge a head that moved while the user was deciding", async () => {
		const github = fakeGitHub();
		const { session, results } = await chatSession(github, [
			EDIT,
			["push_changes", { message: "Change" }],
			["open_pull_request", { title: "Fix" }],
			["merge_pull_request", {}],
		]);
		const confirm = vi.fn(async (request) => {
			if (request.action === "merge") {
				// Someone pushes to the branch before the user answers.
				const moved = await github.getPullRequest();
				github.getPullRequest.mockResolvedValue({
					...moved,
					head: { sha: "c9" },
				});
			}
			return true;
		});

		await session.send("Open a PR and merge it", { confirm });

		expect(github.mergePullRequest).not.toHaveBeenCalled();
		expect(results.at(-1)).toContain("head changed");
	});

	it("asks for a push before a pull request", async () => {
		const github = fakeGitHub();
		const { session, results } = await chatSession(github, [
			EDIT,
			["open_pull_request", { title: "Fix" }],
		]);

		await session.send("Open a PR", { confirm: async () => true });

		expect(results[1]).toBe(
			"error: Push the staged edits first (push_changes), then open the pull request.",
		);
		expect(github.createPullRequest).not.toHaveBeenCalled();
	});
});
