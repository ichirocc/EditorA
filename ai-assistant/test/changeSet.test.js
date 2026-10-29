import { describe, expect, it } from "vitest";
import ChangeSet from "../core/changeSet.js";

describe("AI assistant change set", () => {
	it("keeps the branch version across repeated edits", () => {
		const changes = new ChangeSet();
		changes.write("a.js", "v1", "v2");
		changes.write("a.js", "v2", "v3");

		expect(changes.get("a.js")).toEqual({
			path: "a.js",
			original: "v1",
			content: "v3",
			mode: "100644",
		});
	});

	it("drops a change that returns to the branch version", () => {
		const changes = new ChangeSet();
		changes.write("a.js", "v1", "v2");
		changes.write("a.js", "v2", "v1");
		expect(changes.size).toBe(0);
	});

	it("drops a new file that is deleted again", () => {
		const changes = new ChangeSet();
		changes.write("new.js", null, "x");
		changes.delete("new.js", "x");
		expect(changes.has("new.js")).toBe(false);
	});

	it("keeps the original mode of an executable file", () => {
		const changes = new ChangeSet();
		changes.write("run.sh", "echo 1", "echo 2", "100755");
		changes.write("run.sh", "echo 2", "echo 3");
		expect(changes.get("run.sh").mode).toBe("100755");
	});

	it("builds git tree entries, deleting with a null sha", () => {
		const changes = new ChangeSet();
		changes.write("b.js", "old", "new");
		changes.delete("a.js", "gone");
		changes.write("c.js", null, "created");

		expect(changes.toTreeEntries()).toEqual([
			{ path: "a.js", mode: "100644", type: "blob", sha: null },
			{ path: "b.js", mode: "100644", type: "blob", content: "new" },
			{ path: "c.js", mode: "100644", type: "blob", content: "created" },
		]);
	});

	it("reverts and clears", () => {
		const changes = new ChangeSet();
		changes.write("a.js", "1", "2");
		changes.write("b.js", "1", "2");
		changes.revert("a.js");
		expect(changes.list().map((change) => change.path)).toEqual(["b.js"]);
		changes.clear();
		expect(changes.size).toBe(0);
	});
});
