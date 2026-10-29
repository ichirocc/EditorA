import { describe, expect, it } from "vitest";
import { STRING_TABLES, t } from "../web/i18n.js";
import { escapeHtml, renderMarkdown } from "../web/markdown.js";

describe("web UI markdown", () => {
	it("renders paragraphs, code, bold, headings and lists", () => {
		expect(
			renderMarkdown(
				"# Plan\nChange **one** line in `a.js`:\n\n- read\n- edit\n\n```js\nconst a = 1;\n```",
			),
		).toBe(
			'<h3>Plan</h3><p>Change <strong>one</strong> line in <code>a.js</code>:</p><ul><li>read</li><li>edit</li></ul><pre data-lang="js"><code>const a = 1;</code></pre>',
		);
	});

	it("escapes HTML everywhere, including inside code", () => {
		const html = renderMarkdown(
			"<img src=x onerror=alert(1)> `<script>` **<b>x</b>**\n```\n</code></pre><script>alert(1)</script>\n```",
		);
		expect(html).not.toMatch(/<img|<script|<b>|onerror=alert\(1\)>/);
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(html).toContain("<code>&lt;script&gt;</code>");
		expect(html).toContain(
			"<pre><code>&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>",
		);
	});

	it("links only http(s) URLs and keeps attributes quoted", () => {
		expect(renderMarkdown("[docs](https://example.com/a?b=1&c=2)")).toBe(
			'<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a></p>',
		);
		expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("<a");
		expect(
			renderMarkdown('[x](https://e.com/"onmouseover="alert(1))'),
		).not.toContain('"onmouseover');
	});

	it("escapes all five HTML special characters", () => {
		expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
			"&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
		);
	});
});

describe("web UI strings", () => {
	it("has every string in English and Japanese", () => {
		expect(Object.keys(STRING_TABLES.ja).sort()).toEqual(
			Object.keys(STRING_TABLES.en).sort(),
		);
	});

	it("fills placeholders", () => {
		expect(t("mergeConfirm", { number: 3, branch: "main" }, "en")).toBe(
			"Squash-merge pull request #3 into main?",
		);
		expect(t("mergeConfirm", { number: 3, branch: "main" }, "ja")).toBe(
			"プルリクエスト #3 を main にスカッシュマージしますか？",
		);
		expect(t("missing key", {}, "ja")).toBe("missing key");
	});
});
