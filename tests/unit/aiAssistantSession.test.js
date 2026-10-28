import AssistantSession from "lib/aiAssistant/session";
import { describe, expect, it, vi } from "vitest";

function fakeGitHub() {
	return {
		getBranchHead: vi.fn(async () => ({ commitSha: "base", treeSha: "tree0" })),
		listFiles: vi.fn(async () => ({
			files: [{ path: "a.js", mode: "100644" }],
			truncated: false,
		})),
		readFile: vi.fn(async (_o, _r, path) => (path === "a.js" ? "one\n" : null)),
		createBranch: vi.fn(async () => ({})),
		commitToBranch: vi.fn(async () => ({ commitSha: "c1", treeSha: "tree1" })),
		createPullRequest: vi.fn(async (_o, _r, pr) => ({
			number: 5,
			title: pr.title,
			state: "open",
			merged: false,
			head: { sha: "c1" },
		})),
		getPullRequest: vi.fn(async () => ({
			number: 5,
			title: "Fix",
			state: "open",
			merged: false,
			draft: false,
			mergeable: true,
			mergeable_state: "clean",
			head: { sha: "c1" },
		})),
		listCheckRuns: vi.fn(async () => [
			{ name: "build", status: "completed", conclusion: "success" },
		]),
		getCombinedStatus: vi.fn(async () => ({ statuses: [] })),
		mergePullRequest: vi.fn(async () => ({ merged: true })),
	};
}

/** A runTurn stand-in that edits a.js through the real tool executor. */
async function editingTurn({ messages, executeTool }) {
	await executeTool("edit_file", {
		path: "a.js",
		old_string: "one",
		new_string: "two",
	});
	messages.push({ role: "assistant", content: [{ type: "text", text: "ok" }] });
}

async function startedSession(github = fakeGitHub(), runTurn = editingTurn) {
	const session = new AssistantSession({
		github,
		claude: {},
		model: "claude-opus-5-5",
		owner: "o",
		repo: "r",
		baseBranch: "main",
		runTurn,
		now: () => new Date("2026-10-27T01:02:03Z"),
	});
	await session.start();
	return session;
}

describe("AI assistant session", () => {
	it("walks briefing → edit → push → PR → merge", async () => {
		const github = fakeGitHub();
		const session = await startedSession(github);
		expect(session.phase).toBe("briefing");

		await session.send("Change one to two");
		expect(session.phase).toBe("editing");
		expect(session.changeSet.get("a.js").content).toBe("two\n");

		await session.push("Change one to two");
		expect(github.createBranch).toHaveBeenCalledWith(
			"o",
			"r",
			"ai/edit-20261027-010203",
			"base",
		);
		expect(github.commitToBranch).toHaveBeenCalledWith("o", "r", {
			branch: "ai/edit-20261027-010203",
			parents: ["base"],
			baseTreeSha: "tree0",
			message: "Change one to two",
			entries: [
				{ path: "a.js", mode: "100644", type: "blob", content: "two\n" },
			],
		});
		expect(session.phase).toBe("pushed");
		expect(session.head).toEqual({ commitSha: "c1", treeSha: "tree1" });

		await session.openPullRequest({ title: "Fix" });
		expect(github.createPullRequest).toHaveBeenCalledWith("o", "r", {
			title: "Fix",
			head: "ai/edit-20261027-010203",
			base: "main",
			body: "",
		});
		expect(session.phase).toBe("pr");

		const openPr = await github.getPullRequest();
		github.getPullRequest
			.mockResolvedValueOnce(openPr)
			.mockResolvedValueOnce({ ...openPr, state: "closed", merged: true });
		await session.merge();
		expect(github.mergePullRequest).toHaveBeenCalledWith("o", "r", 5, {
			sha: "c1",
			merge_method: "squash",
			commit_title: "Fix (#5)",
		});
		expect(session.phase).toBe("merged");
		await expect(session.send("more")).rejects.toThrow(/merged/);
	});

	it("reuses the work branch for follow-up pushes", async () => {
		const github = fakeGitHub();
		const session = await startedSession(github);
		await session.send("edit");
		await session.push("first");

		github.readFile.mockResolvedValue("two\n");
		session.changeSet.write("a.js", "two\n", "three\n");
		github.commitToBranch.mockResolvedValueOnce({
			commitSha: "c2",
			treeSha: "tree2",
		});
		await session.push("second");

		expect(github.createBranch).toHaveBeenCalledTimes(1);
		expect(github.commitToBranch.mock.calls[1][2]).toMatchObject({
			parents: ["c1"],
			baseTreeSha: "tree1",
		});
		expect([...session.pushedPaths]).toEqual(["a.js"]);
	});

	it("reads files from the head it last pushed", async () => {
		const github = fakeGitHub();
		const session = await startedSession(github);
		await session.send("edit");
		await session.push("first");
		await session.send("edit again").catch(() => {});

		const refs = github.readFile.mock.calls.map((call) => call[3]);
		expect(refs).toEqual(["base", "c1"]);
	});

	it("refuses to merge when CI fails and never calls the merge API", async () => {
		const github = fakeGitHub();
		github.listCheckRuns.mockResolvedValue([
			{ name: "tests", status: "completed", conclusion: "failure" },
		]);
		const session = await startedSession(github);
		await session.send("edit");
		await session.push("edit");
		await session.openPullRequest({ title: "Fix" });

		const error = await session.merge().catch((e) => e);
		expect(error.readiness.blockers).toEqual([
			{ code: "ci failed", names: ["tests"] },
		]);
		expect(github.mergePullRequest).not.toHaveBeenCalled();
	});

	it("blocks the merge when someone else pushed to the branch", async () => {
		const github = fakeGitHub();
		github.getPullRequest.mockResolvedValue({
			...(await github.getPullRequest()),
			head: { sha: "someone-else" },
		});
		const session = await startedSession(github);
		await session.send("edit");
		await session.push("edit");
		await session.openPullRequest({ title: "Fix" });

		const readiness = await session.refreshStatus();
		expect(readiness.ready).toBe(false);
		expect(readiness.blockers).toContainEqual({ code: "head changed" });
	});

	it("blocks the merge while edits are staged but not pushed", async () => {
		const session = await startedSession();
		await session.send("edit");
		await session.push("edit");
		await session.openPullRequest({ title: "Fix" });
		session.changeSet.write("b.js", null, "new");

		const readiness = await session.refreshStatus();
		expect(readiness.blockers).toContainEqual({ code: "unpushed" });
	});

	it("requires a push before opening a pull request", async () => {
		const session = await startedSession();
		await expect(session.openPullRequest({ title: "x" })).rejects.toThrow(
			/Push/,
		);
		await expect(session.push("x")).rejects.toThrow(/no staged changes/);
	});

	it("removes the user message when the turn fails before any reply", async () => {
		const session = await startedSession(fakeGitHub(), async () => {
			throw new Error("401 invalid x-api-key");
		});
		const error = await session.send("hello").catch((e) => e);
		expect(error.userMessageRemoved).toBe(true);
		expect(session.messages).toEqual([]);
	});

	it("sends the app state note only when it changed", async () => {
		const session = await startedSession(fakeGitHub(), async ({ messages }) => {
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
			});
		});
		await session.send("first");
		await session.send("second");
		session.changeSet.write("x.js", null, "x");
		await session.send("third");

		const userTexts = session.messages
			.filter((message) => message.role === "user")
			.map((message) => message.content.map((block) => block.text));
		expect(userTexts[0][0]).toMatch(/^<app_state>/);
		expect(userTexts[0][1]).toBe("first");
		expect(userTexts[1]).toEqual(["second"]);
		expect(userTexts[2][0]).toMatch(/Staged, not yet pushed: x\.js/);
		expect(session.briefTitle).toBe("first");
	});
});
