/**
 * Line diff used to show staged AI edits before they are pushed.
 *
 * Myers' O((N+M)D) algorithm on the lines left after trimming the common
 * prefix and suffix, which keeps typical small edits to large files cheap.
 */

/**
 * @typedef {object} DiffLine
 * @property {"equal"|"add"|"del"} type
 * @property {string} text
 * @property {number|null} oldLine 1-based line number in the old text
 * @property {number|null} newLine 1-based line number in the new text
 */

/**
 * @typedef {object} DiffHunk
 * @property {number} oldStart
 * @property {number} oldLines
 * @property {number} newStart
 * @property {number} newLines
 * @property {DiffLine[]} lines
 */

/**
 * Splits text into lines. A trailing newline does not produce an empty line.
 * @param {string|null|undefined} text
 * @returns {string[]}
 */
export function splitLines(text) {
	if (!text) return [];
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/**
 * Computes a line diff between two texts.
 * @param {string|null} oldText
 * @param {string|null} newText
 * @returns {DiffLine[]}
 */
export function diffLines(oldText, newText) {
	const a = splitLines(oldText);
	const b = splitLines(newText);

	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		start++;
	}
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}

	/**@type {DiffLine[]} */
	const result = [];
	for (let i = 0; i < start; i++) {
		result.push({ type: "equal", text: a[i], oldLine: i + 1, newLine: i + 1 });
	}

	const ops = myers(a.slice(start, endA), b.slice(start, endB));
	let oldLine = start;
	let newLine = start;
	for (const op of ops) {
		if (op.type === "equal") {
			oldLine++;
			newLine++;
			result.push({ type: "equal", text: op.text, oldLine, newLine });
		} else if (op.type === "del") {
			oldLine++;
			result.push({ type: "del", text: op.text, oldLine, newLine: null });
		} else {
			newLine++;
			result.push({ type: "add", text: op.text, oldLine: null, newLine });
		}
	}

	for (let i = endA; i < a.length; i++) {
		oldLine++;
		newLine++;
		result.push({ type: "equal", text: a[i], oldLine, newLine });
	}

	return result;
}

/**
 * Groups a line diff into hunks with the given amount of context.
 * @param {string|null} oldText
 * @param {string|null} newText
 * @param {number} [context=3]
 * @returns {DiffHunk[]}
 */
export function diffHunks(oldText, newText, context = 3) {
	const lines = diffLines(oldText, newText);
	/**@type {[number, number][]} */
	const ranges = [];

	lines.forEach((line, i) => {
		if (line.type === "equal") return;
		const from = Math.max(i - context, 0);
		const to = Math.min(i + context, lines.length - 1);
		const last = ranges[ranges.length - 1];
		if (last && from <= last[1] + 1) {
			last[1] = to;
		} else {
			ranges.push([from, to]);
		}
	});

	return ranges.map(([from, to]) => {
		const hunkLines = lines.slice(from, to + 1);
		const oldNumbers = hunkLines.filter((l) => l.oldLine !== null);
		const newNumbers = hunkLines.filter((l) => l.newLine !== null);
		return {
			// An empty side starts after the line preceding the hunk, as in `diff -u`.
			oldStart: oldNumbers[0]?.oldLine ?? countBefore(lines, from, "oldLine"),
			oldLines: oldNumbers.length,
			newStart: newNumbers[0]?.newLine ?? countBefore(lines, from, "newLine"),
			newLines: newNumbers.length,
			lines: hunkLines,
		};
	});
}

/**
 * Counts added and removed lines.
 * @param {string|null} oldText
 * @param {string|null} newText
 * @returns {{added:number, removed:number}}
 */
export function diffStat(oldText, newText) {
	let added = 0;
	let removed = 0;
	for (const line of diffLines(oldText, newText)) {
		if (line.type === "add") added++;
		else if (line.type === "del") removed++;
	}
	return { added, removed };
}

/**
 * Last line number on one side before the given diff index (0 if none).
 * @param {DiffLine[]} lines
 * @param {number} index
 * @param {"oldLine"|"newLine"} side
 * @returns {number}
 */
function countBefore(lines, index, side) {
	for (let i = index - 1; i >= 0; i--) {
		if (lines[i][side] !== null) return lines[i][side];
	}
	return 0;
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {{type:"equal"|"add"|"del", text:string}[]}
 */
function myers(a, b) {
	const n = a.length;
	const m = b.length;
	if (!n) return b.map((text) => ({ type: "add", text }));
	if (!m) return a.map((text) => ({ type: "del", text }));

	const max = n + m;
	const offset = max;
	const v = new Int32Array(2 * max + 2);
	/**@type {Int32Array[]} */
	const trace = [];

	outer: for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x =
				k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
					? v[offset + k + 1]
					: v[offset + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) break outer;
		}
	}

	const ops = [];
	let x = n;
	let y = m;
	for (let d = trace.length - 1; d >= 0; d--) {
		const vd = trace[d];
		const k = x - y;
		const prevK =
			k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])
				? k + 1
				: k - 1;
		const prevX = vd[offset + prevK];
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			ops.push({ type: "equal", text: a[x - 1] });
			x--;
			y--;
		}
		if (d === 0) break;
		if (x === prevX) {
			ops.push({ type: "add", text: b[y - 1] });
		} else {
			ops.push({ type: "del", text: a[x - 1] });
		}
		x = prevX;
		y = prevY;
	}

	return ops.reverse();
}
