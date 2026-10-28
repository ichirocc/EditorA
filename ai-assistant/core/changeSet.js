/**
 * Edits the assistant has made but the user has not pushed yet.
 *
 * Each entry remembers the file as it was on the branch (`original`, null for
 * a new file) so the UI can show a diff and the user can revert one file.
 */

/**
 * @typedef {object} StagedChange
 * @property {string} path
 * @property {string|null} original content on the branch, null if the file is new
 * @property {string|null} content new content, null if the file is deleted
 * @property {string} mode git file mode to commit with
 */

export default class ChangeSet {
	/**@type {Map<string, StagedChange>} */
	#changes = new Map();

	/**
	 * Stages new content for a file.
	 * @param {string} path
	 * @param {string|null} original content on the branch, null for a new file
	 * @param {string} content
	 * @param {string} [mode="100644"]
	 */
	write(path, original, content, mode = "100644") {
		this.#set(path, original, content, mode);
	}

	/**
	 * Stages the deletion of a file.
	 * @param {string} path
	 * @param {string|null} original content on the branch, null for a new file
	 * @param {string} [mode="100644"]
	 */
	delete(path, original, mode = "100644") {
		this.#set(path, original, null, mode);
	}

	/**
	 * Drops the staged change for a file.
	 * @param {string} path
	 */
	revert(path) {
		this.#changes.delete(path);
	}

	clear() {
		this.#changes.clear();
	}

	/**
	 * @param {string} path
	 * @returns {StagedChange|undefined}
	 */
	get(path) {
		return this.#changes.get(path);
	}

	/**
	 * @param {string} path
	 * @returns {boolean}
	 */
	has(path) {
		return this.#changes.has(path);
	}

	/**@returns {StagedChange[]} sorted by path */
	list() {
		return [...this.#changes.values()].sort((a, b) =>
			a.path.localeCompare(b.path),
		);
	}

	/**@type {number} */
	get size() {
		return this.#changes.size;
	}

	/**
	 * Tree entries for `POST /repos/{owner}/{repo}/git/trees`.
	 * @returns {{path:string, mode:string, type:"blob", content?:string, sha?:null}[]}
	 */
	toTreeEntries() {
		return this.list().map(({ path, content, mode }) =>
			content === null
				? { path, mode, type: "blob", sha: null }
				: { path, mode, type: "blob", content },
		);
	}

	#set(path, original, content, mode) {
		const previous = this.#changes.get(path);
		const base = previous ? previous.original : original;
		if (base === content) {
			// Back to what is on the branch (or a new file deleted again):
			// nothing left to push.
			this.#changes.delete(path);
			return;
		}
		this.#changes.set(path, {
			path,
			original: base,
			content,
			mode: previous?.mode ?? mode,
		});
	}
}
