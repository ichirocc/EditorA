import { describe, expect, it, vi } from "vitest";
import AssistantSession from "../core/session.js";

/**
 * A tiny repository: commit sha → files. The work branch "c1" was cut from
 * "b0"; "main2" is the base branch after someone else merged a change.
 */
function fakeRepo({ mainA = "1\n2\n3\n4\nfive\n" } = {}) {
	const commits = {
		b0: { "a.js": "1\n2\n3\n4\n5\n", "b.js": "keep\n", "old.js": "old\n" },
		c1: { "a.js": "one\n2\n3\n4\n5\n", "b.js": "keep\n", "new.js": "new\n" },
		main2: { "a.js": mainA, "b.js": "changed\n", "old.js": "old\n" },
	};
	const trees = { t0: "b0", t1: "c1", tm2: "main2" };
	let mainHead = { commitSha: "b0", treeSha: "t0" };

	const github = {
		getBranchHead: vi.fn(async () => mainHead),
		listFiles: vi.fn(async (_o, _r, treeSha) => ({
			files: Object.keys(commits[trees[treeSha]]).map((path) => ({
				path,
				mode: "100644",
			})),
			truncated: false,
		})),
		readFile: vi.fn(async (_o, _r, path, ref) => commits[ref][path] ?? null),
		createBranch: vi.fn(async () => ({})),
		commitToBranch: vi
			.fn()
			.mockResolvedValueOnce({ commitSha: "c1", treeSha: "t1" })
			.mockResolvedValueOnce({ commitSha: "m1", treeSha: "tm1" }),
		compare: vi.fn(async (_o, _r, from, to) => {
			if (from === "main2" && to === "c1") {
				return {
					behind_by: 1,
					merge_base_commit: { sha: "b0" },
					files: [
						{ filename: "a.js", status: "modified" },
						{ filename: "new.js", status: "added" },
						{ filename: "old.js", status: "removed" },
					],
				};
			}
			if (from === "b0" && to === "main2") {
				return {
					files: [
						{ filename: "a.js", status: "modified" },
						{ filename: "b.js", status: "modified" },
					],
				};
			}
			if (from === "b0" && to === "c1") {
				return { behind_by: 0, merge_base_commit: { sha: "b0" }, files: [] };
			}
			throw new Error(`Unexpected compare ${from}...${to}`);
		}),
		getPullRequest: vi.fn(async () => ({
			number: 5,
			title: "Fix",
			state: "open",
			merged: false,
			mergeable: false,
			mergeable_state: "dirty",
			head: { sha: "c1" },
		})),
		listCheckRuns: vi.fn(async () => []),
		getCombinedStatus: vi.fn(async () => ({ statuses: [] })),
		listCheckRunAnnotations: vi.fn(async () => [
			{
				path: "a.js",
				start_line: 1,
				annotation_level: "failure",
				message: "expected 1",
			},
			{
				path: ".github",
				start_line: 1,
				annotation_level: "notice",
				message: "noise",
			},
		]),
		getJobLogTail: vi.fn(async () => "FAIL a.test.js"),
	};
	return {
		github,
		moveMain: () => {
			mainHead = { commitSha: "main2", treeSha: "tm2" };
		},
	};
}

/**
 * Starts a session whose work branch holds commit c1 (the push is replayed
 * through the real tools so the session state matches).
 */
async function pushedSession(repo, runTurn) {
	let turn = 0;
	const session = new AssistantSession({
		github: repo.github,
		owner: "o",
		repo: "r",
		baseBranch: "main",
		now: () => new Date("2026-10-27T01:02:03Z"),
		ai: {
			model: "test-model",
			userMessage: (texts) => ({
				role: "user",
				content: texts.map((text) => ({ type: "text", text })),
			}),
			runTurn: async (options) => {
				if (turn++ === 0) {
					await options.executeTool("edit_file", {
						path: "a.js",
						old_string: "1\n",
						new_string: "one\n",
					});
					await options.executeTool("write_file", {
						path: "new.js",
						content: "new\n",
					});
					await options.executeTool("delete_file", { path: "old.js" });
					options.messages.push({ role: "assistant", content: [] });
					return;
				}
				await runTurn?.(options);
			},
		},
	});
	await session.start();
	await session.send("edit");
	await session.push("edit");
	return session;
}

describe("AI assistant session: merging the base branch", () => {
	it("reports a branch that already has the latest base", async () => {
		const repo = fakeRepo();
		const session = await pushedSession(repo);
		await expect(session.syncWithBase()).resolves.toEqual({
			upToDate: true,
			conflicted: [],
		});
		expect(session.merging).toBe(null);
		expect(session.changeSet.size).toBe(0);
	});

	it("merges separate changes cleanly and pushes a merge commit", async () => {
		const repo = fakeRepo();
		const session = await pushedSession(repo);
		repo.moveMain();

		await expect(session.syncWithBase()).resolves.toEqual({
			upToDate: false,
			conflicted: [],
		});
		expect(session.phase).toBe("merging");
		// Staged changes are the branch's changes on top of the latest main.
		expect(
			session.changeSet.list().map(({ path, original, content }) => ({
				path,
				original,
				content,
			})),
		).toEqual([
			{
				path: "a.js",
				original: "1\n2\n3\n4\nfive\n",
				content: "one\n2\n3\n4\nfive\n",
			},
			{ path: "new.js", original: null, content: "new\n" },
			{ path: "old.js", original: "old\n", content: null },
		]);
		expect(session.mergeMessage).toBe(
			"Merge branch 'main' into ai/edit-20261027-010203",
		);

		await session.push(session.mergeMessage);
		expect(repo.github.commitToBranch.mock.calls[1][2]).toMatchObject({
			branch: "ai/edit-20261027-010203",
			parents: ["c1", "main2"],
			baseTreeSha: "tm2",
			message: "Merge branch 'main' into ai/edit-20261027-010203",
		});
		expect(session.merging).toBe(null);
		expect(session.head).toEqual({ commitSha: "m1", treeSha: "tm1" });
	});

	it("blocks the push until conflicts are resolved, then commits the resolution", async () => {
		const repo = fakeRepo({ mainA: "uno\n2\n3\n4\n5\n" });
		const session = await pushedSession(
			repo,
			async ({ messages, executeTool }) => {
				// The assistant reads the conflicted file and resolves it.
				const conflicted = await executeTool("read_file", { path: "a.js" });
				expect(conflicted).toContain("<<<<<<< ai/edit-20261027-010203");
				expect(conflicted).toContain(">>>>>>> main");
				await executeTool("write_file", {
					path: "a.js",
					content: "one (uno)\n2\n3\n4\n5\n",
				});
				messages.push({ role: "assistant", content: [] });
			},
		);
		repo.moveMain();

		const { conflicted } = await session.syncWithBase();
		expect(conflicted).toEqual(["a.js"]);
		expect(session.unresolvedConflicts).toEqual(["a.js"]);

		const blocked = await session.push("merge").catch((error) => error);
		expect(blocked.conflicts).toEqual(["a.js"]);
		expect(repo.github.commitToBranch).toHaveBeenCalledOnce();

		// While merging, the PR head is still the branch tip: no "head changed".
		session.pr = { number: 5 };
		const readiness = await session.refreshStatus();
		// (No CI has reported for the just-pushed commit yet, hence "ci starting".)
		expect(readiness.blockers.map(({ code }) => code)).toEqual([
			"conflict",
			"ci starting",
			"unpushed",
		]);

		await session.send("resolve the conflicts");
		const note = session.messages.at(-2).content[0].text;
		expect(note).toContain("Merging main into the work branch");
		expect(note).toContain("Unresolved conflict markers: a.js");
		expect(session.unresolvedConflicts).toEqual([]);

		await session.push("merge");
		expect(repo.github.commitToBranch.mock.calls[1][2].entries).toContainEqual({
			path: "a.js",
			mode: "100644",
			type: "blob",
			content: "one (uno)\n2\n3\n4\n5\n",
		});
	});

	it("aborts a merge and goes back to the branch tip", async () => {
		const repo = fakeRepo({ mainA: "uno\n2\n3\n4\n5\n" });
		const session = await pushedSession(repo);
		repo.moveMain();
		await session.syncWithBase();

		session.abortMerge();
		expect(session.merging).toBe(null);
		expect(session.changeSet.size).toBe(0);
		expect(session.head).toEqual({ commitSha: "c1", treeSha: "t1" });
		await expect(session.syncWithBase()).resolves.toMatchObject({
			conflicted: ["a.js"],
		});
	});

	it("refuses to merge the base branch over unpushed edits", async () => {
		const repo = fakeRepo();
		const session = await pushedSession(repo);
		session.changeSet.write("x.js", null, "x");
		await expect(session.syncWithBase()).rejects.toThrow(/Push the staged/);
	});

	it("builds a CI failure report with annotations and the log tail", async () => {
		const repo = fakeRepo();
		const session = await pushedSession(repo);
		session.readiness = {
			checks: [
				{
					name: "tests",
					state: "failure",
					summary: "1 failed",
					checkRunId: 7,
					actions: true,
				},
				{ name: "external", state: "failure", summary: "", checkRunId: 8 },
				{ name: "lint", state: "success" },
			],
		};

		const report = await session.ciFailureReport();
		expect(report).toBe(
			[
				"### tests",
				"1 failed",
				"Annotations:\n- a.js:1 failure: expected 1",
				"End of the job log:\n```\nFAIL a.test.js\n```",
				"### external",
				"Annotations:\n- a.js:1 failure: expected 1",
			].join("\n\n"),
		);
		expect(repo.github.getJobLogTail).toHaveBeenCalledOnce();
		expect(repo.github.getJobLogTail).toHaveBeenCalledWith("o", "r", 7);
	});
});
