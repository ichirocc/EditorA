/**
 * Minimal GitHub REST client for the AI assistant: read a branch, commit
 * staged changes to a work branch, open a pull request and merge it.
 *
 * All Git writes go through the Git Data API so a multi-file change lands as
 * one commit, and every ref update is a fast-forward (`force: false`).
 */

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const LOG_TAIL_LINES = 120;
const LOG_TAIL_CHARS = 6000;

export class GitHubError extends Error {
	/**
	 * @param {string} message
	 * @param {number} status HTTP status, 0 for network failures
	 * @param {any} [body] parsed response body
	 */
	constructor(message, status, body) {
		super(message);
		this.name = "GitHubError";
		this.status = status;
		this.body = body;
	}
}

/**
 * Encodes each path segment but keeps the slashes.
 * @param {string} path
 * @returns {string}
 */
function encodePath(path) {
	return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * Decodes base64 into a UTF-8 string.
 * @param {string} base64
 * @returns {string}
 */
function decodeBase64Utf8(base64) {
	const binary = atob(base64.replace(/\s/g, ""));
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

/**
 * Last lines of a GitHub Actions job log, without timestamps or colours.
 * @param {string} log
 * @returns {string}
 */
export function tailJobLog(log) {
	const lines = log
		.replace(/\x1b\[[0-9;]*m/g, "")
		.split(/\r?\n/)
		.map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ""))
		.filter((line) => line.trim());
	return lines.slice(-LOG_TAIL_LINES).join("\n").slice(-LOG_TAIL_CHARS);
}

/**
 * @param {object} options
 * @param {string} options.token fine-grained or classic personal access token
 * @param {typeof fetch} [options.fetch]
 * @param {(url:string, headers:Record<string,string>) => Promise<string>} [options.getText]
 *   GET that follows redirects to another host. Job logs redirect to a host
 *   without CORS headers, so `fetch` in a browser cannot read them; in Node
 *   plain `fetch` works and is the default.
 */
export function createGitHubClient({
	token,
	fetch: fetchImpl = fetch,
	getText = null,
}) {
	/**
	 * @param {string} method
	 * @param {string} path API path starting with "/"
	 * @param {object} [body]
	 * @returns {Promise<any>}
	 */
	async function request(method, path, body) {
		/**@type {Response} */
		let response;
		try {
			response = await fetchImpl(`${API_ROOT}${path}`, {
				method,
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
					"X-GitHub-Api-Version": API_VERSION,
					...(body ? { "Content-Type": "application/json" } : {}),
				},
				body: body ? JSON.stringify(body) : undefined,
				cache: "no-store",
			});
		} catch (error) {
			throw new GitHubError(
				`Network error: ${error?.message || error}`,
				0,
				null,
			);
		}

		const text = await response.text();
		let data = null;
		if (text) {
			try {
				data = JSON.parse(text);
			} catch {
				data = text;
			}
		}

		if (!response.ok) {
			const details = Array.isArray(data?.errors)
				? data.errors
						.map((error) => error.message || error.code)
						.filter(Boolean)
						.join("; ")
				: "";
			const message = data?.message || response.statusText || "Request failed";
			throw new GitHubError(
				`GitHub ${response.status}: ${message}${details ? ` (${details})` : ""}`,
				response.status,
				data,
			);
		}

		return data;
	}

	const repoPath = (owner, repo) =>
		`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

	return {
		request,

		/**
		 * @returns {Promise<{login:string}>}
		 */
		getUser() {
			return request("GET", "/user");
		},

		/**
		 * @param {string} owner
		 * @param {string} repo
		 */
		getRepo(owner, repo) {
			return request("GET", repoPath(owner, repo));
		},

		/**
		 * Head commit and root tree of a branch.
		 * @param {string} owner
		 * @param {string} repo
		 * @param {string} branch
		 * @returns {Promise<{commitSha:string, treeSha:string}>}
		 */
		async getBranchHead(owner, repo, branch) {
			const data = await request(
				"GET",
				`${repoPath(owner, repo)}/branches/${encodePath(branch)}`,
			);
			return {
				commitSha: data.commit.sha,
				treeSha: data.commit.commit.tree.sha,
			};
		},

		/**
		 * Every blob in a tree, recursively.
		 * @param {string} owner
		 * @param {string} repo
		 * @param {string} treeSha
		 * @returns {Promise<{files:{path:string, mode:string, size:number}[], truncated:boolean}>}
		 */
		async listFiles(owner, repo, treeSha) {
			const data = await request(
				"GET",
				`${repoPath(owner, repo)}/git/trees/${treeSha}?recursive=1`,
			);
			return {
				files: data.tree
					.filter((entry) => entry.type === "blob")
					.map(({ path, mode, size }) => ({ path, mode, size })),
				truncated: !!data.truncated,
			};
		},

		/**
		 * Text content of a file at a ref, or null if it does not exist.
		 * @param {string} owner
		 * @param {string} repo
		 * @param {string} path
		 * @param {string} ref branch name or commit sha
		 * @returns {Promise<string|null>}
		 */
		async readFile(owner, repo, path, ref) {
			let data;
			try {
				data = await request(
					"GET",
					`${repoPath(owner, repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
				);
			} catch (error) {
				if (error instanceof GitHubError && error.status === 404) return null;
				throw error;
			}
			if (Array.isArray(data) || data.type !== "file") {
				throw new GitHubError(`${path} is not a file`, 422, data);
			}
			if (data.encoding === "base64" && typeof data.content === "string") {
				return decodeBase64Utf8(data.content);
			}
			// Files over 1 MB come back without inline content.
			const blob = await request(
				"GET",
				`${repoPath(owner, repo)}/git/blobs/${data.sha}`,
			);
			return decodeBase64Utf8(blob.content);
		},

		/**
		 * @param {string} owner
		 * @param {string} repo
		 * @param {string} branch
		 * @param {string} sha commit to start the branch at
		 */
		createBranch(owner, repo, branch, sha) {
			return request("POST", `${repoPath(owner, repo)}/git/refs`, {
				ref: `refs/heads/${branch}`,
				sha,
			});
		},

		/**
		 * Commits tree entries and fast-forwards the branch to the new commit.
		 * The first parent must be the branch's current head; GitHub refuses
		 * the update (422) if the branch moved. A second parent makes it a
		 * merge commit.
		 * @param {string} owner
		 * @param {string} repo
		 * @param {object} commit
		 * @param {string} commit.branch
		 * @param {string[]} commit.parents
		 * @param {string} commit.baseTreeSha tree the entries are applied to
		 * @param {string} commit.message
		 * @param {object[]} commit.entries tree entries (see ChangeSet#toTreeEntries)
		 * @returns {Promise<{commitSha:string, treeSha:string}>}
		 */
		async commitToBranch(
			owner,
			repo,
			{ branch, parents, baseTreeSha, message, entries },
		) {
			const base = repoPath(owner, repo);
			const tree = entries.length
				? await request("POST", `${base}/git/trees`, {
						base_tree: baseTreeSha,
						tree: entries,
					})
				: { sha: baseTreeSha };
			const commit = await request("POST", `${base}/git/commits`, {
				message,
				tree: tree.sha,
				parents,
			});
			await request("PATCH", `${base}/git/refs/heads/${encodePath(branch)}`, {
				sha: commit.sha,
				force: false,
			});
			return { commitSha: commit.sha, treeSha: tree.sha };
		},

		/**
		 * @param {string} owner
		 * @param {string} repo
		 * @param {{title:string, head:string, base:string, body?:string}} pr
		 */
		createPullRequest(owner, repo, pr) {
			return request("POST", `${repoPath(owner, repo)}/pulls`, pr);
		},

		/**
		 * @param {string} owner
		 * @param {string} repo
		 * @param {number} number
		 */
		getPullRequest(owner, repo, number) {
			return request("GET", `${repoPath(owner, repo)}/pulls/${number}`);
		},

		/**
		 * Legacy commit statuses (e.g. external CI services).
		 * @param {string} owner
		 * @param {string} repo
		 * @param {string} sha
		 */
		getCombinedStatus(owner, repo, sha) {
			return request(
				"GET",
				`${repoPath(owner, repo)}/commits/${sha}/status?per_page=100`,
			);
		},

		/**
		 * Check runs (GitHub Actions and other apps).
		 * @param {string} owner
		 * @param {string} repo
		 * @param {string} sha
		 */
		async listCheckRuns(owner, repo, sha) {
			const data = await request(
				"GET",
				`${repoPath(owner, repo)}/commits/${sha}/check-runs?per_page=100`,
			);
			return data.check_runs;
		},

		/**
		 * Error lines a check run reported (file, line, message).
		 * @param {string} owner
		 * @param {string} repo
		 * @param {number} checkRunId
		 * @returns {Promise<{path:string, start_line:number, annotation_level:string, message:string, title?:string}[]>}
		 */
		listCheckRunAnnotations(owner, repo, checkRunId) {
			return request(
				"GET",
				`${repoPath(owner, repo)}/check-runs/${checkRunId}/annotations?per_page=30`,
			);
		},

		/**
		 * Tail of a GitHub Actions job log (a check run's id is its job id).
		 * Resolves null when logs cannot be read in this environment.
		 * @param {string} owner
		 * @param {string} repo
		 * @param {number} jobId
		 * @returns {Promise<string|null>}
		 */
		async getJobLogTail(owner, repo, jobId) {
			if (!getText) return null;
			const log = await getText(
				`${API_ROOT}${repoPath(owner, repo)}/actions/jobs/${jobId}/logs`,
				{
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
					"X-GitHub-Api-Version": API_VERSION,
				},
			);
			return tailJobLog(log);
		},

		/**
		 * Compares `base...head`: the merge base, how far each side moved, and
		 * the files `head` changed since the merge base (up to 300).
		 * @param {string} owner
		 * @param {string} repo
		 * @param {string} base
		 * @param {string} head
		 */
		compare(owner, repo, base, head) {
			return request(
				"GET",
				`${repoPath(owner, repo)}/compare/${base}...${head}?per_page=1`,
			);
		},

		/**
		 * Squash-merges a pull request. `sha` makes GitHub refuse the merge (409)
		 * if the head moved after the user reviewed it.
		 * @param {string} owner
		 * @param {string} repo
		 * @param {number} number
		 * @param {{sha:string, commit_title?:string, merge_method?:"squash"|"merge"|"rebase"}} options
		 */
		mergePullRequest(owner, repo, number, options) {
			return request("PUT", `${repoPath(owner, repo)}/pulls/${number}/merge`, {
				merge_method: "squash",
				...options,
			});
		},
	};
}

/**@typedef {ReturnType<typeof createGitHubClient>} GitHubClient */
