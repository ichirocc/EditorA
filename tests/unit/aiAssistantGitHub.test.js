import { createGitHubClient, GitHubError } from "lib/aiAssistant/github";
import { describe, expect, it, vi } from "vitest";

/**
 * @param {Record<string, {status?:number, body?:any}>} routes keyed by "METHOD path"
 */
function fakeFetch(routes) {
	return vi.fn(async (url, init) => {
		const key = `${init.method} ${url.replace("https://api.github.com", "")}`;
		const route = routes[key];
		if (!route) throw new Error(`Unexpected request: ${key}`);
		const status = route.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			statusText: "",
			text: async () =>
				route.body === undefined ? "" : JSON.stringify(route.body),
		};
	});
}

const base64 = (text) => Buffer.from(text, "utf8").toString("base64");

describe("AI assistant GitHub client", () => {
	it("sends the token and API version", async () => {
		const fetch = fakeFetch({ "GET /user": { body: { login: "me" } } });
		const github = createGitHubClient({ token: "t0k", fetch });

		await expect(github.getUser()).resolves.toEqual({ login: "me" });
		const [, init] = fetch.mock.calls[0];
		expect(init.headers.Authorization).toBe("Bearer t0k");
		expect(init.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
	});

	it("reads the head commit and tree of a branch", async () => {
		const github = createGitHubClient({
			token: "t",
			fetch: fakeFetch({
				"GET /repos/o/r/branches/feature/x": {
					body: { commit: { sha: "c1", commit: { tree: { sha: "t1" } } } },
				},
			}),
		});
		await expect(github.getBranchHead("o", "r", "feature/x")).resolves.toEqual({
			commitSha: "c1",
			treeSha: "t1",
		});
	});

	it("lists only blobs from the recursive tree", async () => {
		const github = createGitHubClient({
			token: "t",
			fetch: fakeFetch({
				"GET /repos/o/r/git/trees/t1?recursive=1": {
					body: {
						truncated: false,
						tree: [
							{ path: "src", type: "tree", mode: "040000" },
							{ path: "src/a.js", type: "blob", mode: "100644", size: 3 },
						],
					},
				},
			}),
		});
		await expect(github.listFiles("o", "r", "t1")).resolves.toEqual({
			files: [{ path: "src/a.js", mode: "100644", size: 3 }],
			truncated: false,
		});
	});

	it("decodes UTF-8 file content and returns null for missing files", async () => {
		const github = createGitHubClient({
			token: "t",
			fetch: fakeFetch({
				"GET /repos/o/r/contents/docs/%E6%97%A5%E6%9C%AC.md?ref=c1": {
					body: {
						type: "file",
						encoding: "base64",
						content: base64("こんにちは\n"),
					},
				},
				"GET /repos/o/r/contents/missing.js?ref=c1": {
					status: 404,
					body: { message: "Not Found" },
				},
			}),
		});
		await expect(github.readFile("o", "r", "docs/日本.md", "c1")).resolves.toBe(
			"こんにちは\n",
		);
		await expect(github.readFile("o", "r", "missing.js", "c1")).resolves.toBe(
			null,
		);
	});

	it("falls back to the blob API for files over 1 MB", async () => {
		const github = createGitHubClient({
			token: "t",
			fetch: fakeFetch({
				"GET /repos/o/r/contents/big.txt?ref=c1": {
					body: { type: "file", encoding: "none", content: "", sha: "b1" },
				},
				"GET /repos/o/r/git/blobs/b1": { body: { content: base64("big") } },
			}),
		});
		await expect(github.readFile("o", "r", "big.txt", "c1")).resolves.toBe(
			"big",
		);
	});

	it("commits a tree on top of the parent and fast-forwards the branch", async () => {
		const fetch = fakeFetch({
			"POST /repos/o/r/git/trees": { status: 201, body: { sha: "t2" } },
			"POST /repos/o/r/git/commits": { status: 201, body: { sha: "c2" } },
			"PATCH /repos/o/r/git/refs/heads/ai/edit-1": { body: {} },
		});
		const github = createGitHubClient({ token: "t", fetch });
		const entries = [
			{ path: "a.js", mode: "100644", type: "blob", content: "x" },
		];

		await expect(
			github.commitToBranch("o", "r", {
				branch: "ai/edit-1",
				parents: ["c1"],
				baseTreeSha: "t1",
				message: "Fix",
				entries,
			}),
		).resolves.toEqual({ commitSha: "c2", treeSha: "t2" });

		const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(init.body));
		expect(bodies[0]).toEqual({ base_tree: "t1", tree: entries });
		expect(bodies[1]).toEqual({ message: "Fix", tree: "t2", parents: ["c1"] });
		expect(bodies[2]).toEqual({ sha: "c2", force: false });
	});

	it("creates a merge commit with two parents", async () => {
		const fetch = fakeFetch({
			"POST /repos/o/r/git/commits": { status: 201, body: { sha: "m1" } },
			"PATCH /repos/o/r/git/refs/heads/ai/edit-1": { body: {} },
		});
		const github = createGitHubClient({ token: "t", fetch });
		await expect(
			github.commitToBranch("o", "r", {
				branch: "ai/edit-1",
				parents: ["c1", "main1"],
				baseTreeSha: "tmain",
				message: "Merge",
				entries: [],
			}),
		).resolves.toEqual({ commitSha: "m1", treeSha: "tmain" });
		// Without entries the base tree is reused as is.
		expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
			message: "Merge",
			tree: "tmain",
			parents: ["c1", "main1"],
		});
	});

	it("compares branches and lists check annotations", async () => {
		const github = createGitHubClient({
			token: "t",
			fetch: fakeFetch({
				"GET /repos/o/r/compare/main1...c1?per_page=1": {
					body: { behind_by: 2, merge_base_commit: { sha: "mb" }, files: [] },
				},
				"GET /repos/o/r/check-runs/9/annotations?per_page=30": {
					body: [{ path: "a.js", start_line: 3, message: "boom" }],
				},
			}),
		});
		await expect(
			github.compare("o", "r", "main1", "c1"),
		).resolves.toMatchObject({
			behind_by: 2,
		});
		await expect(
			github.listCheckRunAnnotations("o", "r", 9),
		).resolves.toHaveLength(1);
	});

	it("reads the tail of a job log through the native GET", async () => {
		const log = [
			"2026-10-27T03:59:25.1234567Z ##[group]Run npm test",
			...Array.from(
				{ length: 200 },
				(_, i) => `2026-10-27T03:59:26Z line ${i}`,
			),
			"2026-10-27T03:59:27Z \x1b[31mFAIL\x1b[0m tests/a.test.js",
		].join("\n");
		const getText = vi.fn(async () => log);
		const github = createGitHubClient({
			token: "t0k",
			fetch: fakeFetch({}),
			getText,
		});

		const tail = await github.getJobLogTail("o", "r", 42);
		expect(getText).toHaveBeenCalledWith(
			"https://api.github.com/repos/o/r/actions/jobs/42/logs",
			expect.objectContaining({ Authorization: "Bearer t0k" }),
		);
		const lines = tail.split("\n");
		expect(lines).toHaveLength(120);
		expect(lines.at(-1)).toBe("FAIL tests/a.test.js");
		expect(lines[0]).toBe("line 81");

		const withoutNative = createGitHubClient({
			token: "t",
			fetch: fakeFetch({}),
		});
		await expect(withoutNative.getJobLogTail("o", "r", 42)).resolves.toBe(null);
	});

	it("squash-merges the reviewed head", async () => {
		const fetch = fakeFetch({
			"PUT /repos/o/r/pulls/7/merge": { body: { merged: true } },
		});
		const github = createGitHubClient({ token: "t", fetch });
		await github.mergePullRequest("o", "r", 7, { sha: "c2" });
		expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
			merge_method: "squash",
			sha: "c2",
		});
	});

	it("reports API errors with status and details", async () => {
		const github = createGitHubClient({
			token: "t",
			fetch: fakeFetch({
				"POST /repos/o/r/pulls": {
					status: 422,
					body: {
						message: "Validation Failed",
						errors: [{ message: "A pull request already exists" }],
					},
				},
			}),
		});
		const error = await github
			.createPullRequest("o", "r", { title: "x", head: "a", base: "main" })
			.catch((e) => e);
		expect(error).toBeInstanceOf(GitHubError);
		expect(error.status).toBe(422);
		expect(error.message).toBe(
			"GitHub 422: Validation Failed (A pull request already exists)",
		);
	});

	it("wraps network failures", async () => {
		const github = createGitHubClient({
			token: "t",
			fetch: async () => {
				throw new TypeError("Failed to fetch");
			},
		});
		const error = await github.getUser().catch((e) => e);
		expect(error).toBeInstanceOf(GitHubError);
		expect(error.status).toBe(0);
	});
});
