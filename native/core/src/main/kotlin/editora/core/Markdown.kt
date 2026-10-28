package editora.core

/**
 * Small CommonMark/GFM subset to HTML, for previews.
 *
 * Supported: ATX and setext headings, paragraphs, fenced code, blockquotes,
 * nested bullet/ordered/task lists, horizontal rules, pipe tables, and inline
 * code, bold, italic, strikethrough, links, images and autolinks.
 *
 * Raw HTML in the source is escaped, and only http(s), mailto and relative
 * link targets are kept, so the output is safe to show with scripts off.
 */
object Markdown {
	fun toHtml(markdown: String): String {
		val lines = markdown.replace("\r\n", "\n").replace('\t', ' ').split('\n')
		val out = StringBuilder()
		renderBlocks(lines, out)
		return out.toString()
	}

	private val HEADING = Regex("^ {0,3}(#{1,6})(?:\\s+(.*?))?\\s*#*\\s*$")
	private val FENCE = Regex("^ {0,3}(```+|~~~+)\\s*([^`\\s]*).*$")
	private val RULE = Regex("^ {0,3}([-*_])(?:\\s*\\1){2,}\\s*$")
	private val BULLET = Regex("^( *)([-*+])\\s+(.*)$")
	private val ORDERED = Regex("^( *)(\\d{1,9})[.)]\\s+(.*)$")
	private val QUOTE = Regex("^ {0,3}> ?(.*)$")
	private val TABLE_DIVIDER = Regex("^\\s*\\|?\\s*:?-+:?\\s*(\\|\\s*:?-+:?\\s*)*\\|?\\s*$")
	private val SETEXT = Regex("^ {0,3}(=+|-+)\\s*$")

	private fun renderBlocks(lines: List<String>, out: StringBuilder) {
		var i = 0
		while (i < lines.size) {
			val line = lines[i]
			if (line.isBlank()) {
				i++
				continue
			}

			val fence = FENCE.matchEntire(line)
			if (fence != null) {
				val marker = fence.groupValues[1]
				val lang = fence.groupValues[2]
				val code = StringBuilder()
				i++
				while (i < lines.size && !lines[i].trimStart().startsWith(marker)) {
					code.append(lines[i]).append('\n')
					i++
				}
				i++ // closing fence
				val cls = if (lang.isNotEmpty()) " class=\"language-${escape(lang)}\"" else ""
				out.append("<pre><code").append(cls).append('>').append(escape(code.toString())).append("</code></pre>\n")
				continue
			}

			val heading = HEADING.matchEntire(line)
			if (heading != null) {
				val level = heading.groupValues[1].length
				out.append("<h$level>").append(inline(heading.groupValues[2])).append("</h$level>\n")
				i++
				continue
			}

			if (RULE.matches(line)) {
				out.append("<hr>\n")
				i++
				continue
			}

			if (QUOTE.matches(line)) {
				val quoted = ArrayList<String>()
				while (i < lines.size && lines[i].isNotBlank()) {
					quoted += QUOTE.matchEntire(lines[i])?.groupValues?.get(1) ?: lines[i]
					i++
				}
				out.append("<blockquote>\n")
				renderBlocks(quoted, out)
				out.append("</blockquote>\n")
				continue
			}

			if (BULLET.matches(line) || ORDERED.matches(line)) {
				i = renderList(lines, i, out)
				continue
			}

			if (i + 1 < lines.size && line.contains('|') && TABLE_DIVIDER.matches(lines[i + 1])) {
				i = renderTable(lines, i, out)
				continue
			}

			// Paragraph, possibly turned into a setext heading by its underline.
			val paragraph = ArrayList<String>()
			var setextLevel = 0
			while (i < lines.size && lines[i].isNotBlank()) {
				val underline = SETEXT.matchEntire(lines[i])
				if (underline != null && paragraph.isNotEmpty()) {
					setextLevel = if (underline.groupValues[1].startsWith("=")) 1 else 2
					i++
					break
				}
				if (paragraph.isNotEmpty() && startsBlock(lines[i])) break
				paragraph += lines[i]
				i++
			}
			if (setextLevel > 0) {
				out.append("<h$setextLevel>").append(inline(paragraph.joinToString(" ") { it.trim() })).append("</h$setextLevel>\n")
			} else {
				val body = paragraph.joinToString("\n") { it.trim() }
				out.append("<p>").append(inline(body).replace("\n", "<br>\n")).append("</p>\n")
			}
		}
	}

	private fun startsBlock(line: String) =
		FENCE.matches(line) || HEADING.matches(line) || RULE.matches(line) || QUOTE.matches(line) ||
			BULLET.matches(line) || ORDERED.matches(line)

	/** Renders consecutive list items starting at [start]; returns the next line index. */
	private fun renderList(lines: List<String>, start: Int, out: StringBuilder): Int {
		val first = BULLET.matchEntire(lines[start]) ?: ORDERED.matchEntire(lines[start])!!
		val indent = first.groupValues[1].length
		val ordered = ORDERED.matches(lines[start])
		val tag = if (ordered) "ol" else "ul"
		val startNumber = if (ordered) first.groupValues[2].toIntOrNull() ?: 1 else 1
		out.append('<').append(tag)
		if (ordered && startNumber != 1) out.append(" start=\"").append(startNumber).append('"')
		out.append(">\n")

		var i = start
		while (i < lines.size) {
			val match = (if (ordered) ORDERED else BULLET).matchEntire(lines[i]) ?: break
			if (match.groupValues[1].length != indent) break
			var content = match.groupValues[3]
			val task = Regex("^\\[([ xX])]\\s+(.*)$").matchEntire(content)
			out.append("<li>")
			if (task != null) {
				val checked = task.groupValues[1] != " "
				out.append("<input type=\"checkbox\" disabled").append(if (checked) " checked" else "").append("> ")
				content = task.groupValues[2]
			}
			out.append(inline(content))
			i++
			// Continuation lines and nested lists (indented further).
			val nested = ArrayList<String>()
			while (i < lines.size && lines[i].isNotBlank()) {
				val next = lines[i]
				val nextIndent = next.length - next.trimStart().length
				if ((BULLET.matches(next) || ORDERED.matches(next)) && nextIndent <= indent) break
				nested += next.drop(minOf(nextIndent, indent + 2))
				i++
			}
			if (nested.isNotEmpty()) {
				if (nested.any { BULLET.matches(it) || ORDERED.matches(it) }) {
					out.append('\n')
					renderBlocks(nested, out)
				} else {
					out.append(' ').append(inline(nested.joinToString(" ") { it.trim() }))
				}
			}
			out.append("</li>\n")
			// A single blank line between items keeps the list going.
			if (i + 1 < lines.size && lines[i].isBlank()) {
				val after = (if (ordered) ORDERED else BULLET).matchEntire(lines[i + 1])
				if (after != null && after.groupValues[1].length == indent) i++
			}
		}
		out.append("</").append(tag).append(">\n")
		return i
	}

	private fun renderTable(lines: List<String>, start: Int, out: StringBuilder): Int {
		fun cells(line: String): List<String> {
			var row = line.trim()
			if (row.startsWith("|")) row = row.substring(1)
			if (row.endsWith("|") && !row.endsWith("\\|")) row = row.dropLast(1)
			return row.split(Regex("(?<!\\\\)\\|")).map { it.trim().replace("\\|", "|") }
		}
		val header = cells(lines[start])
		val aligns = cells(lines[start + 1]).map {
			when {
				it.startsWith(":") && it.endsWith(":") -> "center"
				it.endsWith(":") -> "right"
				it.startsWith(":") -> "left"
				else -> null
			}
		}
		fun cellTag(tag: String, index: Int, text: String): String {
			val align = aligns.getOrNull(index)?.let { " style=\"text-align:$it\"" } ?: ""
			return "<$tag$align>${inline(text)}</$tag>"
		}
		out.append("<table>\n<thead><tr>")
		header.forEachIndexed { index, text -> out.append(cellTag("th", index, text)) }
		out.append("</tr></thead>\n<tbody>\n")
		var i = start + 2
		while (i < lines.size && lines[i].isNotBlank() && lines[i].contains('|')) {
			out.append("<tr>")
			cells(lines[i]).take(header.size).forEachIndexed { index, text -> out.append(cellTag("td", index, text)) }
			out.append("</tr>\n")
			i++
		}
		out.append("</tbody>\n</table>\n")
		return i
	}

	/** Inline formatting. Code spans are cut out first so nothing inside them is interpreted. */
	fun inline(text: String): String {
		val out = StringBuilder()
		var i = 0
		while (i < text.length) {
			val c = text[i]
			when {
				c == '\\' && i + 1 < text.length && text[i + 1] in ESCAPABLE -> {
					out.append(escape(text[i + 1].toString()))
					i += 2
				}
				c == '`' -> {
					var ticks = 0
					while (i + ticks < text.length && text[i + ticks] == '`') ticks++
					val fence = "`".repeat(ticks)
					val close = text.indexOf(fence, i + ticks)
					if (close < 0) {
						out.append(fence)
						i += ticks
					} else {
						out.append("<code>").append(escape(text.substring(i + ticks, close).trim())).append("</code>")
						i = close + ticks
					}
				}
				c == '!' && text.startsWith("[", i + 1) -> {
					val link = parseLink(text, i + 1)
					if (link == null) {
						out.append('!')
						i++
					} else {
						val src = safeUrl(link.url)
						if (src == null) out.append(escape(link.label)) else
							out.append("<img src=\"").append(escapeAttribute(src)).append("\" alt=\"").append(escapeAttribute(link.label)).append("\">")
						i = link.end
					}
				}
				c == '[' -> {
					val link = parseLink(text, i)
					if (link == null) {
						out.append('[')
						i++
					} else {
						val href = safeUrl(link.url)
						if (href == null) out.append(inline(link.label)) else
							out.append("<a href=\"").append(escapeAttribute(href)).append("\">").append(inline(link.label)).append("</a>")
						i = link.end
					}
				}
				c == '<' -> {
					val close = text.indexOf('>', i + 1)
					val target = if (close > 0) text.substring(i + 1, close) else ""
					val href = if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:")) safeUrl(target) else null
					if (href != null && ' ' !in target) {
						out.append("<a href=\"").append(escapeAttribute(href)).append("\">").append(escape(target)).append("</a>")
						i = close + 1
					} else {
						out.append("&lt;")
						i++
					}
				}
				else -> {
					val emphasis = parseEmphasis(text, i)
					if (emphasis != null) {
						out.append(emphasis.first)
						i = emphasis.second
					} else {
						out.append(escape(c.toString()))
						i++
					}
				}
			}
		}
		return out.toString()
	}

	private const val ESCAPABLE = "\\`*_{}[]()#+-.!|~<>"

	private val EMPHASIS = listOf("**" to "strong", "__" to "strong", "~~" to "del", "*" to "em", "_" to "em")

	/** Returns the rendered emphasis and the index after it, if [start] opens one. */
	private fun parseEmphasis(text: String, start: Int): Pair<String, Int>? {
		for ((marker, tag) in EMPHASIS) {
			if (!text.startsWith(marker, start)) continue
			val contentStart = start + marker.length
			if (contentStart >= text.length || text[contentStart].isWhitespace()) continue
			// "_" inside words (snake_case) is not emphasis.
			if (marker == "_" && start > 0 && text[start - 1].isLetterOrDigit()) continue
			var close = text.indexOf(marker, contentStart)
			while (close > 0 && (text[close - 1].isWhitespace() || (marker.length == 1 && text.startsWith(marker + marker, close)))) {
				close = text.indexOf(marker, close + marker.length)
			}
			if (close <= contentStart) continue
			if (marker == "_" && close + 1 < text.length && text[close + 1].isLetterOrDigit()) continue
			return "<$tag>${inline(text.substring(contentStart, close))}</$tag>" to close + marker.length
		}
		return null
	}

	private class Link(val label: String, val url: String, val end: Int)

	/** Parses `[label](url "title")` starting at the '[' at [start]. */
	private fun parseLink(text: String, start: Int): Link? {
		var depth = 0
		var i = start
		while (i < text.length) {
			when (text[i]) {
				'\\' -> i++
				'[' -> depth++
				']' -> {
					depth--
					if (depth == 0) break
				}
			}
			i++
		}
		if (i >= text.length || i + 1 >= text.length || text[i + 1] != '(') return null
		val close = text.indexOf(')', i + 2)
		if (close < 0) return null
		val target = text.substring(i + 2, close).trim()
		val url = target.substringBefore(' ').removePrefix("<").removeSuffix(">")
		return Link(text.substring(start + 1, i), url, close + 1)
	}

	/** Keeps web, mail and relative targets; drops javascript:, data: and other schemes. */
	internal fun safeUrl(url: String): String? {
		val trimmed = url.trim()
		if (trimmed.isEmpty()) return null
		val scheme = Regex("^([a-zA-Z][a-zA-Z0-9+.-]*):").find(trimmed)?.groupValues?.get(1)?.lowercase()
		return if (scheme == null || scheme in setOf("http", "https", "mailto")) trimmed else null
	}

	fun escape(text: String): String {
		val out = StringBuilder(text.length)
		for (c in text) {
			when (c) {
				'&' -> out.append("&amp;")
				'<' -> out.append("&lt;")
				'>' -> out.append("&gt;")
				'"' -> out.append("&quot;")
				else -> out.append(c)
			}
		}
		return out.toString()
	}

	private fun escapeAttribute(text: String) = escape(text).replace("'", "&#39;")
}
