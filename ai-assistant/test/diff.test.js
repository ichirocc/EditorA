import { describe, expect, it } from "vitest";
import { diffHunks, diffLines, diffStat, splitLines } from "../core/diff.js";

function render(lines) {
	return lines.map((line) => {
		const prefix = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
		return `${prefix}${line.text}`;
	});
}

describe("AI assistant diff", () => {
	it("splits lines without a phantom trailing line", () => {
		expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
		expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
		expect(splitLines("")).toEqual([]);
		expect(splitLines(null)).toEqual([]);
	});

	it("produces a minimal line diff", () => {
		const lines = diffLines("a\nb\nc\nd\n", "a\nB\nc\nd\ne\n");
		expect(render(lines)).toEqual([" a", "-b", "+B", " c", " d", "+e"]);
	});

	it("numbers lines on each side", () => {
		const lines = diffLines("x\ny\n", "x\nz\ny\n");
		expect(lines).toEqual([
			{ type: "equal", text: "x", oldLine: 1, newLine: 1 },
			{ type: "add", text: "z", oldLine: null, newLine: 2 },
			{ type: "equal", text: "y", oldLine: 2, newLine: 3 },
		]);
	});

	it("diffs new and deleted files", () => {
		expect(render(diffLines(null, "a\nb"))).toEqual(["+a", "+b"]);
		expect(render(diffLines("a\nb", null))).toEqual(["-a", "-b"]);
	});

	it("handles changes in the middle of unrelated lines", () => {
		const oldText = "1\n2\n3\n4\n5\n6\n7\n";
		const newText = "1\n2\nthree\n4\n5\nsix\n7\n";
		expect(render(diffLines(oldText, newText))).toEqual([
			" 1",
			" 2",
			"-3",
			"+three",
			" 4",
			" 5",
			"-6",
			"+six",
			" 7",
		]);
	});

	it("groups changes into hunks with context", () => {
		const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
		const newLines = [...oldLines];
		newLines[1] = "changed 2";
		newLines[17] = "changed 18";
		const hunks = diffHunks(
			`${oldLines.join("\n")}\n`,
			`${newLines.join("\n")}\n`,
			2,
		);

		expect(hunks).toHaveLength(2);
		expect(hunks[0]).toMatchObject({
			oldStart: 1,
			oldLines: 4,
			newStart: 1,
			newLines: 4,
		});
		expect(render(hunks[0].lines)).toEqual([
			" line 1",
			"-line 2",
			"+changed 2",
			" line 3",
			" line 4",
		]);
		expect(hunks[1]).toMatchObject({ oldStart: 16, newStart: 16 });
	});

	it("merges hunks whose context overlaps", () => {
		const oldText = "a\nb\nc\nd\ne\n";
		const newText = "A\nb\nc\nd\nE\n";
		expect(diffHunks(oldText, newText, 2)).toHaveLength(1);
		expect(diffHunks(oldText, newText, 1)).toHaveLength(2);
	});

	it("starts an empty side after the preceding line", () => {
		const [hunk] = diffHunks("a\nb\n", "a\nb\nc\n", 0);
		expect(hunk).toMatchObject({
			oldStart: 2,
			oldLines: 0,
			newStart: 3,
			newLines: 1,
		});
	});

	it("counts added and removed lines", () => {
		expect(diffStat("a\nb\nc", "a\nc\nd\ne")).toEqual({
			added: 2,
			removed: 1,
		});
		expect(diffStat("same", "same")).toEqual({ added: 0, removed: 0 });
	});

	it("stays correct on larger random edits", () => {
		let seed = 7;
		const random = () => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return seed / 2 ** 31;
		};
		for (let round = 0; round < 20; round++) {
			const a = Array.from({ length: 60 }, () => `${Math.floor(random() * 8)}`);
			const b = a
				.filter(() => random() > 0.2)
				.flatMap((line) => (random() > 0.8 ? [line, "new"] : [line]));
			const lines = diffLines(a.join("\n"), b.join("\n"));
			expect(
				lines.filter((line) => line.type !== "add").map((line) => line.text),
			).toEqual(a);
			expect(
				lines.filter((line) => line.type !== "del").map((line) => line.text),
			).toEqual(b);
		}
	});
});
