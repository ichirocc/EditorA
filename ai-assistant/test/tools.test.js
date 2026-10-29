import { beforeEach, describe, expect, it } from "vitest";
import ChangeSet from "../core/changeSet.js";
import {
	createToolExecutor,
	normalizeRepoPath,
	TOOLS,
	ToolInputError,
	validateToolInput,
} from "../core/tools.js";

const branchFiles = {
	"README.md": "# Demo\n",
	"src/app.js": "const a = 1;\nconst b = 2;\nconst a2 = 1;\n",
	"bin/run.sh": "echo run\n",
};

let changeSet;
let execute;

beforeEach(() => {
	changeSet = new ChangeSet();
	execute = createToolExecutor({
		changeSet,
		listBranchFiles: async () => ({
			files: Object.keys(branchFiles).map((path) => ({
				path,
				mode: path.endsWith(".sh") ? "100755" : "100644",
			})),
			truncated: false,
		}),
		readBranchFile: async (path) => branchFiles[path] ?? null,
	});
});

describe("AI assistant tools", () => {
	it("defines streaming tools with object schemas", () => {
		for (const tool of TOOLS) {
			expect(tool.input_schema.type).toBe("object");
			expect(tool.eager_input_streaming).toBe(true);
		}
	});

	it("confines paths to the repository", () => {
		expect(normalizeRepoPath("./src/app.js")).toBe("src/app.js");
		expect(normalizeRepoPath("/src/app.js")).toBe("src/app.js");
		for (const bad of [
			"../etc/passwd",
			"src/../../x",
			"src//app.js",
			".git/config",
			"a\\b",
			"",
			42,
		]) {
			expect(() => normalizeRepoPath(bad)).toThrow(ToolInputError);
		}
	});

	it("validates inputs against the schema", () => {
		const editTool = TOOLS.find((tool) => tool.name === "edit_file");
		expect(() => validateToolInput(editTool, { path: "a" })).toThrow(
			/missing "old_string"/,
		);
		expect(() =>
			validateToolInput(editTool, {
				path: "a",
				old_string: "x",
				new_string: 1,
			}),
		).toThrow(/"new_string" must be a string/);
		const readTool = TOOLS.find((tool) => tool.name === "read_file");
		expect(() =>
			validateToolInput(readTool, { path: "a", start_line: 1.5 }),
		).toThrow(/integer/);
		expect(() => validateToolInput(readTool, "a")).toThrow(ToolInputError);
	});

	it("reads branch files and line ranges", async () => {
		await expect(execute("read_file", { path: "README.md" })).resolves.toBe(
			"# Demo\n",
		);
		await expect(
			execute("read_file", { path: "src/app.js", start_line: 2, end_line: 2 }),
		).resolves.toBe("const b = 2;");
		await expect(execute("read_file", { path: "nope.js" })).rejects.toThrow(
			/File not found/,
		);
	});

	it("stages an exact edit and reads it back", async () => {
		await execute("edit_file", {
			path: "src/app.js",
			old_string: "const b = 2;",
			new_string: "const b = 3;",
		});
		expect(changeSet.get("src/app.js")).toMatchObject({
			original: branchFiles["src/app.js"],
			content: "const a = 1;\nconst b = 3;\nconst a2 = 1;\n",
		});
		await expect(
			execute("read_file", { path: "src/app.js", start_line: 2, end_line: 2 }),
		).resolves.toBe("const b = 3;");
	});

	it("refuses ambiguous or missing edits", async () => {
		await expect(
			execute("edit_file", {
				path: "src/app.js",
				old_string: "= 1;",
				new_string: "= 9;",
			}),
		).rejects.toThrow(/appears 2 times/);
		await expect(
			execute("edit_file", {
				path: "src/app.js",
				old_string: "missing",
				new_string: "x",
			}),
		).rejects.toThrow(/not found/);
		expect(changeSet.size).toBe(0);

		await execute("edit_file", {
			path: "src/app.js",
			old_string: "= 1;",
			new_string: "= 9;",
			replace_all: true,
		});
		expect(changeSet.get("src/app.js").content).toBe(
			"const a = 9;\nconst b = 2;\nconst a2 = 9;\n",
		);
	});

	it("does not treat $ patterns in new_string specially", async () => {
		await execute("edit_file", {
			path: "README.md",
			old_string: "# Demo",
			new_string: "# $& $1 $$",
		});
		expect(changeSet.get("README.md").content).toBe("# $& $1 $$\n");
	});

	it("creates, deletes and lists files including staged changes", async () => {
		await expect(
			execute("write_file", { path: "src/new.js", content: "new\n" }),
		).resolves.toBe("Created src/new.js.");
		await execute("delete_file", { path: "README.md" });
		await execute("edit_file", {
			path: "bin/run.sh",
			old_string: "run",
			new_string: "go",
		});

		await expect(execute("list_files", {})).resolves.toBe(
			"bin/run.sh\nsrc/app.js\nsrc/new.js",
		);
		await expect(execute("list_files", { prefix: "src/" })).resolves.toBe(
			"src/app.js\nsrc/new.js",
		);
		expect(changeSet.get("bin/run.sh").mode).toBe("100755");
		expect(changeSet.get("README.md").content).toBe(null);
	});

	it("refuses to read or edit binary files", async () => {
		branchFiles["logo.png"] = "\x89PNG\0\0";
		await expect(execute("read_file", { path: "logo.png" })).rejects.toThrow(
			/binary/,
		);
		await expect(
			execute("edit_file", {
				path: "logo.png",
				old_string: "PNG",
				new_string: "x",
			}),
		).rejects.toThrow(/binary/);
		// Deleting or replacing a binary file is still allowed.
		await execute("delete_file", { path: "logo.png" });
		expect(changeSet.get("logo.png").content).toBe(null);
		delete branchFiles["logo.png"];
	});

	it("rejects unknown tools", async () => {
		await expect(execute("run_shell", {})).rejects.toThrow(/Unknown tool/);
	});
});
