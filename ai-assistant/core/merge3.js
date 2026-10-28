import { diffLines, splitLines } from "./diff.js";

/**
 * Line-based three-way merge, used when the base branch is merged into the
 * work branch. Changes that touch separate lines merge cleanly; changes to
 * the same or adjacent lines (as git treats them) become a conflict block:
 *
 *   <<<<<<< ours label
 *   ...
 *   =======
 *   ...
 *   >>>>>>> theirs label
 */

const MARKER = /^(?:<{7}|>{7})(?: |$)|^={7}$/m;

/**
 * Whether text still contains conflict markers.
 * @param {string|null} text
 * @returns {boolean}
 */
export function hasConflictMarkers(text) {
	return !!text && MARKER.test(text);
}

/**
 * Base line ranges [start, end) that `other` replaces, with the new lines.
 * @param {string} base
 * @param {string} other
 * @returns {{start:number, end:number, lines:string[]}[]}
 */
function changeRegions(base, other) {
	const regions = [];
	let baseIndex = 0;
	let current = null;
	for (const line of diffLines(base, other)) {
		if (line.type === "equal") {
			current = null;
			baseIndex++;
			continue;
		}
		if (!current) {
			current = { start: baseIndex, end: baseIndex, lines: [] };
			regions.push(current);
		}
		if (line.type === "del") {
			baseIndex++;
			current.end = baseIndex;
		} else {
			current.lines.push(line.text);
		}
	}
	return regions;
}

/**
 * @param {string} base common ancestor ("" if the file did not exist)
 * @param {string} ours ("" if deleted)
 * @param {string} theirs ("" if deleted)
 * @param {{ours?:string, theirs?:string}} [labels]
 * @returns {{text:string, conflicts:number}}
 */
export function merge3(base, ours, theirs, labels = {}) {
	const baseLines = splitLines(base);
	const regions = [
		...changeRegions(base, ours).map((region) => ({ ...region, ours: true })),
		...changeRegions(base, theirs).map((region) => ({
			...region,
			ours: false,
		})),
	].sort((a, b) => a.start - b.start || a.end - b.end);

	const out = [];
	let conflicts = 0;
	let pos = 0;
	let i = 0;
	while (i < regions.length) {
		const start = regions[i].start;
		let end = regions[i].end;
		const cluster = [regions[i++]];
		// Overlapping or touching regions are resolved together.
		while (i < regions.length && regions[i].start <= end) {
			end = Math.max(end, regions[i].end);
			cluster.push(regions[i++]);
		}

		const apply = (side) => {
			const lines = [];
			let at = start;
			for (const region of side) {
				lines.push(...baseLines.slice(at, region.start), ...region.lines);
				at = region.end;
			}
			lines.push(...baseLines.slice(at, end));
			return lines;
		};
		const mine = cluster.filter((region) => region.ours);
		const yours = cluster.filter((region) => !region.ours);

		out.push(...baseLines.slice(pos, start));
		if (!yours.length) {
			out.push(...apply(mine));
		} else if (!mine.length) {
			out.push(...apply(yours));
		} else {
			const a = apply(mine);
			const b = apply(yours);
			if (a.join("\n") === b.join("\n")) {
				out.push(...a);
			} else {
				conflicts++;
				out.push(
					`<<<<<<< ${labels.ours || "ours"}`,
					...a,
					"=======",
					...b,
					`>>>>>>> ${labels.theirs || "theirs"}`,
				);
			}
		}
		pos = end;
	}
	out.push(...baseLines.slice(pos));

	if (!out.length) return { text: "", conflicts };
	const sample = [ours, theirs, base].find(Boolean) || "";
	const eol = sample.includes("\r\n") ? "\r\n" : "\n";
	const trailing = /\n$/.test(sample) ? eol : "";
	return { text: out.join(eol) + trailing, conflicts };
}
