package editora.core

/** An [edit] to apply plus the selection to show afterwards. */
data class EditResult(val edit: Edit, val selectionStart: Int, val selectionEnd: Int)

/**
 * Line-based editing commands. Each works on the whole lines touched by the
 * selection and returns a single [Edit], so it undoes in one step.
 */
object EditOps {
	private val PAIRS = mapOf('(' to ')', '[' to ']', '{' to '}', '"' to '"', '\'' to '\'', '`' to '`')
	private val CLOSERS = setOf(')', ']', '}', '"', '\'', '`')

	/** Lines `[start, end)` covering the selection; a selection ending at a line start excludes that line. */
	private fun lineRange(text: CharSequence, selStart: Int, selEnd: Int): Pair<Int, Int> {
		val from = minOf(selStart, selEnd).coerceIn(0, text.length)
		var to = maxOf(selStart, selEnd).coerceIn(0, text.length)
		if (to > from && text[to - 1] == '\n') to--
		var start = from
		while (start > 0 && text[start - 1] != '\n') start--
		var end = to
		while (end < text.length && text[end] != '\n') end++
		return start to end
	}

	private fun replaceLines(
		text: CharSequence,
		start: Int,
		end: Int,
		newLines: String,
		selection: Pair<Int, Int>,
	): EditResult = EditResult(Edit(start, text.substring(start, end), newLines), selection.first, selection.second)

	/**
	 * Comments or uncomments the selected lines. Uses the language's line
	 * comment, or wraps each line in its block comment (HTML, CSS).
	 * Returns null for languages without comments.
	 */
	fun toggleComment(text: CharSequence, selStart: Int, selEnd: Int, language: Language): EditResult? {
		val (start, end) = lineRange(text, selStart, selEnd)
		val lines = text.substring(start, end).split('\n')
		val lineMarker = language.lineComments.firstOrNull()
		val block = language.blockComment
		if (lineMarker == null && block == null) return null

		val content = lines.filter { it.isNotBlank() }
		val indent = content.minOfOrNull { it.length - it.trimStart().length } ?: 0
		val allCommented = content.isNotEmpty() && content.all { line ->
			val body = line.trimStart()
			if (lineMarker != null) body.startsWith(lineMarker) else body.startsWith(block!!.first) && body.trimEnd().endsWith(block.second)
		}

		val result = lines.map { line ->
			if (line.isBlank()) return@map line
			if (allCommented) {
				val lead = line.length - line.trimStart().length
				val body = line.substring(lead)
				val stripped = if (lineMarker != null) {
					body.removePrefix(lineMarker).removePrefix(" ")
				} else {
					body.trimEnd().removePrefix(block!!.first).removeSuffix(block.second).removePrefix(" ").removeSuffix(" ")
				}
				line.substring(0, lead) + stripped
			} else {
				val head = line.substring(0, indent)
				val body = line.substring(indent)
				if (lineMarker != null) "$head$lineMarker $body" else "$head${block!!.first} $body ${block.second}"
			}
		}.joinToString("\n")
		return replaceLines(text, start, end, result, start to start + result.length)
	}

	fun indent(text: CharSequence, selStart: Int, selEnd: Int, unit: String): EditResult {
		val (start, end) = lineRange(text, selStart, selEnd)
		val result = text.substring(start, end).split('\n').joinToString("\n") { if (it.isEmpty()) it else unit + it }
		if (selStart == selEnd) {
			// A bare cursor moves with its line.
			val cursor = selStart + if (text.substring(start, end).isEmpty()) 0 else unit.length
			return replaceLines(text, start, end, result, cursor to cursor)
		}
		return replaceLines(text, start, end, result, start to start + result.length)
	}

	fun outdent(text: CharSequence, selStart: Int, selEnd: Int, unit: String): EditResult {
		val (start, end) = lineRange(text, selStart, selEnd)
		var removedBeforeCursor = 0
		var lineStart = start
		val result = text.substring(start, end).split('\n').joinToString("\n") { line ->
			val remove = when {
				line.startsWith('\t') -> 1
				else -> line.takeWhile { it == ' ' }.length.coerceAtMost(unit.length)
			}
			if (lineStart <= selStart) removedBeforeCursor = minOf(remove, selStart - lineStart)
			lineStart += line.length + 1
			line.substring(remove)
		}
		if (selStart == selEnd) {
			val cursor = selStart - removedBeforeCursor
			return replaceLines(text, start, end, result, cursor to cursor)
		}
		return replaceLines(text, start, end, result, start to start + result.length)
	}

	/** Duplicates the selected lines below themselves and selects the copy (or keeps the cursor column). */
	fun duplicateLines(text: CharSequence, selStart: Int, selEnd: Int): EditResult {
		val (start, end) = lineRange(text, selStart, selEnd)
		val block = text.substring(start, end)
		val inserted = "$block\n$block"
		val shift = block.length + 1
		return replaceLines(text, start, end, inserted, (selStart + shift) to (selEnd + shift))
	}

	/** Moves the selected lines up or down by one line; null at the document edge. */
	fun moveLines(text: CharSequence, selStart: Int, selEnd: Int, up: Boolean): EditResult? {
		val (start, end) = lineRange(text, selStart, selEnd)
		val block = text.substring(start, end)
		if (up) {
			if (start == 0) return null
			var prevStart = start - 1
			while (prevStart > 0 && text[prevStart - 1] != '\n') prevStart--
			val previous = text.substring(prevStart, start - 1)
			val shift = previous.length + 1
			return replaceLines(text, prevStart, end, "$block\n$previous", (selStart - shift) to (selEnd - shift))
		}
		if (end >= text.length) return null
		var nextEnd = end + 1
		while (nextEnd < text.length && text[nextEnd] != '\n') nextEnd++
		val next = text.substring(end + 1, nextEnd)
		val shift = next.length + 1
		return replaceLines(text, start, nextEnd, "$next\n$block", (selStart + shift) to (selEnd + shift))
	}

	/**
	 * The closing character to insert after typing [typed], given the
	 * character after the cursor, or null. Quotes are not paired next to
	 * letters or digits (apostrophes in words, for example).
	 */
	fun autoCloseFor(typed: Char, before: Char?, after: Char?): Char? {
		val closing = PAIRS[typed] ?: return null
		if (after != null && !after.isWhitespace() && after !in CLOSERS && after != ',' && after != ';') return null
		if (typed == closing && before != null && (before.isLetterOrDigit() || before == closing)) return null
		return closing
	}

	/** True when typing [typed] should step over the identical closer already after the cursor. */
	fun shouldSkipCloser(typed: Char, after: Char?): Boolean = typed in CLOSERS && after == typed
}
