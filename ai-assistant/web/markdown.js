/**
 * A small Markdown renderer for the assistant's replies: fenced and inline
 * code, bold, headings, lists, paragraphs and http(s) links.
 *
 * Model output is untrusted, so every piece of text is HTML-escaped before
 * any tag is added, and only http(s) URLs become links.
 */

const ESCAPES = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/**
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
	return String(text).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/**
 * Inline formatting of one escaped-on-the-fly line.
 * @param {string} line raw text
 * @returns {string} HTML
 */
function inline(line) {
	const parts = line.split(/(`[^`]+`)/);
	return parts
		.map((part) => {
			if (/^`[^`]+`$/.test(part)) {
				return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
			}
			let html = escapeHtml(part);
			html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
			// Links: the text and URL are already escaped; only http(s).
			html = html.replace(
				/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
				'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
			);
			return html;
		})
		.join("");
}

/**
 * @param {string} text Markdown
 * @returns {string} HTML that is safe to assign to innerHTML
 */
export function renderMarkdown(text) {
	const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
	const out = [];
	/**@type {string[]} */
	let paragraph = [];
	/**@type {string[]|null} */
	let list = null;

	const flush = () => {
		if (paragraph.length) {
			out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
			paragraph = [];
		}
		if (list) {
			out.push(
				`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`,
			);
			list = null;
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fence = line.match(/^```\s*([\w+-]*)\s*$/);
		if (fence) {
			flush();
			const code = [];
			while (++i < lines.length && !/^```\s*$/.test(lines[i])) {
				code.push(lines[i]);
			}
			const lang = fence[1] ? ` data-lang="${escapeHtml(fence[1])}"` : "";
			out.push(`<pre${lang}><code>${escapeHtml(code.join("\n"))}</code></pre>`);
			continue;
		}
		const heading = line.match(/^(#{1,4})\s+(.*)$/);
		if (heading) {
			flush();
			const level = Math.min(heading[1].length + 2, 6);
			out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
			continue;
		}
		const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
		if (item) {
			if (paragraph.length) flush();
			list ??= [];
			list.push(item[1]);
			continue;
		}
		if (!line.trim()) {
			flush();
			continue;
		}
		if (list) flush();
		paragraph.push(line);
	}
	flush();
	return out.join("");
}
