package editora.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MarkdownTest {
	private fun html(md: String) = Markdown.toHtml(md).trim()

	@Test
	fun headingsAndParagraphs() {
		assertEquals("<h1>見出し</h1>\n<p>本文です。</p>", html("# 見出し\n\n本文です。"))
		assertEquals("<h2>Two</h2>", html("## Two ##"))
		assertEquals("<h1>Title</h1>\n<h2>Sub</h2>", html("Title\n=====\nSub\n---"))
	}

	@Test
	fun lineBreaksInsideParagraph() {
		assertEquals("<p>a<br>\nb</p>", html("a\nb"))
	}

	@Test
	fun inlineFormatting() {
		assertEquals(
			"<p><strong>bold</strong> <em>it</em> <del>del</del> <code>a*b</code></p>",
			html("**bold** *it* ~~del~~ `a*b`"),
		)
		assertEquals("<p>snake_case_name</p>", html("snake_case_name"))
		assertEquals("<p>2 * 3 * 4</p>", html("2 * 3 * 4"))
	}

	@Test
	fun linksImagesAndAutolinks() {
		assertEquals("<p><a href=\"https://example.com\">site</a></p>", html("[site](https://example.com)"))
		assertEquals("<p><img src=\"img/a.png\" alt=\"pic\"></p>", html("![pic](img/a.png)"))
		assertEquals("<p><a href=\"https://x.jp\">https://x.jp</a></p>", html("<https://x.jp>"))
	}

	@Test
	fun dangerousContentIsNeutralized() {
		val out = html("<script>alert(1)</script>\n\n[x](javascript:alert(1)) ![y](data:text/html,hi)")
		assertFalse(out.contains("<script"))
		assertFalse(out.contains("javascript:"))
		assertFalse(out.contains("data:"))
		assertTrue(out.contains("&lt;script&gt;"))
	}

	@Test
	fun fencedCodeIsEscapedVerbatim() {
		assertEquals(
			"<pre><code class=\"language-html\">&lt;b&gt;**x**&lt;/b&gt;\n</code></pre>",
			html("```html\n<b>**x**</b>\n```"),
		)
	}

	@Test
	fun listsNestedListsAndTasks() {
		assertEquals(
			"<ul>\n<li>a\n<ul>\n<li>b</li>\n</ul>\n</li>\n<li><input type=\"checkbox\" disabled checked> done</li>\n</ul>",
			html("- a\n  - b\n- [x] done"),
		)
		assertEquals("<ol start=\"3\">\n<li>three</li>\n<li>four</li>\n</ol>", html("3. three\n4. four"))
	}

	@Test
	fun blockquoteAndRule() {
		assertEquals("<blockquote>\n<p>引用</p>\n</blockquote>\n<hr>", html("> 引用\n\n---"))
	}

	@Test
	fun tablesWithAlignment() {
		assertEquals(
			"<table>\n<thead><tr><th>名前</th><th style=\"text-align:right\">数</th></tr></thead>\n" +
				"<tbody>\n<tr><td>りんご</td><td style=\"text-align:right\">3</td></tr>\n</tbody>\n</table>",
			html("| 名前 | 数 |\n|---|---:|\n| りんご | 3 |"),
		)
	}

	@Test
	fun backslashEscapes() {
		assertEquals("<p>*not em*</p>", html("\\*not em\\*"))
	}
}
