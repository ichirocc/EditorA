/**
 * Tools the assistant uses to read the repository and stage edits.
 *
 * Nothing here writes to GitHub: edits go into the ChangeSet and are only
 * committed when the user presses "Push". Tool inputs are model output, so
 * every input is validated and every path is confined to the repository.
 */

const MAX_READ_CHARS = 150_000;
const MAX_LISTED_FILES = 2000;

/**@type {import("@anthropic-ai/sdk").default.Beta.BetaTool[]} */
export const TOOLS = [
	{
		name: "list_files",
		description:
			"List file paths in the repository, including files you created and excluding files you deleted. Use a prefix to list one directory.",
		eager_input_streaming: true,
		input_schema: {
			type: "object",
			properties: {
				prefix: {
					type: "string",
					description: 'Only list paths starting with this, e.g. "src/lib/".',
				},
			},
			required: [],
		},
	},
	{
		name: "read_file",
		description:
			"Read a UTF-8 text file. Returns your staged version if you already edited it. For long files, pass start_line/end_line (1-based, inclusive).",
		eager_input_streaming: true,
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Repository-relative path." },
				start_line: { type: "integer" },
				end_line: { type: "integer" },
			},
			required: ["path"],
		},
	},
	{
		name: "edit_file",
		description:
			"Replace an exact string in a file. old_string must appear exactly once unless replace_all is true; include enough surrounding lines to make it unique. Prefer this over write_file for changes to existing files.",
		eager_input_streaming: true,
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string" },
				old_string: { type: "string" },
				new_string: { type: "string" },
				replace_all: { type: "boolean" },
			},
			required: ["path", "old_string", "new_string"],
		},
	},
	{
		name: "write_file",
		description:
			"Create a file or replace its entire content. Use edit_file for small changes to an existing file.",
		eager_input_streaming: true,
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string" },
				content: { type: "string" },
			},
			required: ["path", "content"],
		},
	},
	{
		name: "delete_file",
		description: "Delete a file.",
		eager_input_streaming: true,
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string" },
			},
			required: ["path"],
		},
	},
];

export class ToolInputError extends Error {}

/**
 * Normalizes a model-supplied path and rejects anything outside the repository.
 * @param {unknown} path
 * @returns {string}
 */
export function normalizeRepoPath(path) {
	if (typeof path !== "string") {
		throw new ToolInputError("path must be a string");
	}
	const trimmed = path
		.trim()
		.replace(/^\.\/+/, "")
		.replace(/^\/+/, "");
	if (!trimmed || trimmed.includes("\0") || trimmed.includes("\\")) {
		throw new ToolInputError(`Invalid path: ${path}`);
	}
	const segments = trimmed.split("/");
	for (const segment of segments) {
		if (!segment || segment === "." || segment === "..") {
			throw new ToolInputError(`Path must stay inside the repository: ${path}`);
		}
	}
	if (segments[0] === ".git") {
		throw new ToolInputError("The .git directory cannot be accessed.");
	}
	return segments.join("/");
}

/**
 * Checks an input object against a tool's JSON schema (top-level types only).
 * @param {import("@anthropic-ai/sdk").default.Beta.BetaTool} tool
 * @param {unknown} input
 * @returns {Record<string, any>}
 */
export function validateToolInput(tool, input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new ToolInputError(
			`INVALID_JSON: ${tool.name} expects an object input`,
		);
	}
	const { properties = {}, required = [] } = tool.input_schema;
	for (const key of required) {
		if (!(key in input)) {
			throw new ToolInputError(`INVALID_JSON: missing "${key}"`);
		}
	}
	for (const [key, value] of Object.entries(input)) {
		const type = properties[key]?.type;
		if (!type || value === undefined) continue;
		// The schemas above only use types whose name matches `typeof`.
		const ok =
			type === "integer" ? Number.isInteger(value) : typeof value === type;
		if (!ok) {
			throw new ToolInputError(`INVALID_JSON: "${key}" must be a ${type}`);
		}
	}
	return input;
}

/**
 * @typedef {object} Workspace
 * @property {import("./changeSet.js").default} changeSet
 * @property {() => Promise<{files:{path:string, mode:string}[], truncated:boolean}>} listBranchFiles
 * @property {(path:string) => Promise<string|null>} readBranchFile
 */

/**
 * @param {Workspace} workspace
 * @returns {(name:string, input:unknown) => Promise<string>} resolves with the
 *   tool result text, rejects with ToolInputError for bad input
 */
export function createToolExecutor(workspace) {
	const { changeSet } = workspace;

	/**
	 * Current content: staged if edited, otherwise what is on the branch.
	 * @param {string} path
	 * @returns {Promise<{content:string|null, original:string|null}>}
	 */
	async function current(path) {
		const staged = changeSet.get(path);
		if (staged) return { content: staged.content, original: staged.original };
		const original = await workspace.readBranchFile(path);
		return { content: original, original };
	}

	/**
	 * Content for reading or editing; decoded binary data is useless to the
	 * model and would be corrupted by a text edit.
	 * @param {string} path
	 */
	async function currentText(path) {
		const file = await current(path);
		if (file.content === null) {
			throw new ToolInputError(`File not found: ${path}`);
		}
		if (file.content.includes("\0")) {
			throw new ToolInputError(`${path} is a binary file.`);
		}
		return file;
	}

	async function modeOf(path) {
		const { files } = await workspace.listBranchFiles();
		return files.find((file) => file.path === path)?.mode;
	}

	const handlers = {
		async list_files({ prefix = "" }) {
			const { files, truncated } = await workspace.listBranchFiles();
			const paths = new Set(files.map((file) => file.path));
			for (const change of changeSet.list()) {
				if (change.content === null) paths.delete(change.path);
				else paths.add(change.path);
			}
			const matching = [...paths]
				.filter((path) => path.startsWith(prefix))
				.sort();
			const shown = matching.slice(0, MAX_LISTED_FILES);
			const notes = [];
			if (matching.length > shown.length) {
				notes.push(
					`(${matching.length - shown.length} more paths; use a longer prefix)`,
				);
			}
			if (truncated) {
				notes.push(
					"(GitHub truncated the tree listing; some files may be missing)",
				);
			}
			if (!shown.length) return "No files match.";
			return [...shown, ...notes].join("\n");
		},

		async read_file({ path, start_line, end_line }) {
			const target = normalizeRepoPath(path);
			const { content } = await currentText(target);
			if (start_line === undefined && end_line === undefined) {
				if (content.length > MAX_READ_CHARS) {
					const lines = content.split("\n").length;
					throw new ToolInputError(
						`${target} is too large to read at once (${lines} lines). Read it in parts with start_line/end_line.`,
					);
				}
				return content;
			}
			const lines = content.split("\n");
			const from = Math.max((start_line ?? 1) - 1, 0);
			const to = Math.min(end_line ?? lines.length, lines.length);
			const slice = lines.slice(from, to).join("\n");
			if (slice.length > MAX_READ_CHARS) {
				throw new ToolInputError("That range is too large; read fewer lines.");
			}
			return slice;
		},

		async edit_file({ path, old_string, new_string, replace_all = false }) {
			const target = normalizeRepoPath(path);
			const { content, original } = await currentText(target);
			if (!old_string) {
				throw new ToolInputError("old_string must not be empty.");
			}
			const count = content.split(old_string).length - 1;
			if (count === 0) {
				throw new ToolInputError(
					`old_string was not found in ${target}. Read the file again and copy the text exactly.`,
				);
			}
			if (count > 1 && !replace_all) {
				throw new ToolInputError(
					`old_string appears ${count} times in ${target}. Add surrounding lines to make it unique, or set replace_all.`,
				);
			}
			const updated = replace_all
				? content.split(old_string).join(new_string)
				: content.replace(old_string, () => new_string);
			changeSet.write(target, original, updated, await modeOf(target));
			return `Edited ${target} (${count} replacement${count > 1 ? "s" : ""}).`;
		},

		async write_file({ path, content }) {
			const target = normalizeRepoPath(path);
			const { original } = await current(target);
			changeSet.write(target, original, content, await modeOf(target));
			return `${original === null ? "Created" : "Wrote"} ${target}.`;
		},

		async delete_file({ path }) {
			const target = normalizeRepoPath(path);
			const { content, original } = await current(target);
			if (content === null) {
				throw new ToolInputError(`File not found: ${target}`);
			}
			changeSet.delete(target, original, await modeOf(target));
			return `Deleted ${target}.`;
		},
	};

	return async (name, input) => {
		const tool = TOOLS.find((entry) => entry.name === name);
		if (!tool) throw new ToolInputError(`Unknown tool: ${name}`);
		return handlers[name](validateToolInput(tool, input));
	};
}
