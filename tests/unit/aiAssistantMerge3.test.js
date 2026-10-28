import { hasConflictMarkers, merge3 } from "lib/aiAssistant/merge3";
import { describe, expect, it } from "vitest";

const lines = (...items) => `${items.join("\n")}\n`;
const labels = { ours: "ai/edit", theirs: "main" };

describe("AI assistant three-way merge", () => {
	it("merges changes to separate lines", () => {
		const base = lines("a", "b", "c", "d", "e");
		const ours = lines("A", "b", "c", "d", "e");
		const theirs = lines("a", "b", "c", "d", "E", "f");
		expect(merge3(base, ours, theirs, labels)).toEqual({
			text: lines("A", "b", "c", "d", "E", "f"),
			conflicts: 0,
		});
	});

	it("takes identical changes once", () => {
		const base = lines("a", "b");
		const both = lines("a", "B");
		expect(merge3(base, both, both)).toEqual({ text: both, conflicts: 0 });
	});

	it("marks conflicting changes to the same line", () => {
		const base = lines("x", "value = 1", "y");
		const ours = lines("x", "value = 2", "y");
		const theirs = lines("x", "value = 3", "y");
		const merged = merge3(base, ours, theirs, labels);
		expect(merged.conflicts).toBe(1);
		expect(merged.text).toBe(
			lines(
				"x",
				"<<<<<<< ai/edit",
				"value = 2",
				"=======",
				"value = 3",
				">>>>>>> main",
				"y",
			),
		);
		expect(hasConflictMarkers(merged.text)).toBe(true);
	});

	it("treats changes to adjacent lines as a conflict, like git", () => {
		const base = lines("a", "b", "c");
		const merged = merge3(base, lines("A", "b", "c"), lines("a", "B", "c"));
		expect(merged.conflicts).toBe(1);
	});

	it("keeps conflicts separate when they are far apart", () => {
		const base = lines("1", "2", "3", "4", "5", "6", "7");
		const ours = lines("one", "2", "3", "4", "5", "6", "seven");
		const theirs = lines("uno", "2", "3", "4", "5", "6", "siete");
		const merged = merge3(base, ours, theirs);
		expect(merged.conflicts).toBe(2);
		expect(merged.text.split("\n").slice(5, 10)).toEqual([
			"2",
			"3",
			"4",
			"5",
			"6",
		]);
	});

	it("handles a file added on both sides", () => {
		expect(merge3("", "same\n", "same\n")).toEqual({
			text: "same\n",
			conflicts: 0,
		});
		expect(merge3("", "ours\n", "theirs\n").conflicts).toBe(1);
	});

	it("conflicts when one side deletes a file the other changed", () => {
		const merged = merge3(lines("a", "b"), "", lines("a", "B"), labels);
		expect(merged.conflicts).toBe(1);
		expect(merged.text).toBe(
			lines("<<<<<<< ai/edit", "=======", "a", "B", ">>>>>>> main"),
		);
	});

	it("keeps CRLF line endings and a missing final newline", () => {
		const base = "a\r\nb\r\nc\r\n";
		expect(merge3(base, "A\r\nb\r\nc\r\n", "a\r\nb\r\nC\r\n").text).toBe(
			"A\r\nb\r\nC\r\n",
		);
		expect(merge3("a\nb\nc", "A\nb\nc", "a\nb\nC").text).toBe("A\nb\nC");
	});

	it("only recognises markers at the start of a line", () => {
		expect(hasConflictMarkers("a = '<<<<<<< not a marker'")).toBe(false);
		expect(hasConflictMarkers("=======\n")).toBe(true);
		expect(hasConflictMarkers("==========\n")).toBe(false);
		expect(hasConflictMarkers(null)).toBe(false);
	});
});
