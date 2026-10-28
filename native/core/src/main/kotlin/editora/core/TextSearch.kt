package editora.core

data class SearchOptions(
	val matchCase: Boolean = false,
	val wholeWord: Boolean = false,
	val regex: Boolean = false,
)

/** Find and replace over plain text. */
object TextSearch {
	/** Builds the pattern, or returns null when [query] is empty or an invalid regex. */
	fun pattern(query: String, options: SearchOptions): Regex? {
		if (query.isEmpty()) return null
		var source = if (options.regex) query else Regex.escape(query)
		if (options.wholeWord) source = "\\b(?:$source)\\b"
		val flags = buildSet {
			add(RegexOption.MULTILINE)
			if (!options.matchCase) add(RegexOption.IGNORE_CASE)
		}
		return try {
			Regex(source, flags)
		} catch (_: IllegalArgumentException) {
			null
		}
	}

	/** First non-empty match at or after [from], wrapping to the start. */
	fun findNext(text: CharSequence, pattern: Regex, from: Int): IntRange? {
		val start = from.coerceIn(0, text.length)
		return firstNonEmpty(pattern, text, start) ?: firstNonEmpty(pattern, text, 0)
	}

	/** Last non-empty match that ends at or before [before], wrapping to the end. */
	fun findPrevious(text: CharSequence, pattern: Regex, before: Int): IntRange? {
		val limit = before.coerceIn(0, text.length)
		var best: IntRange? = null
		var last: IntRange? = null
		for (match in pattern.findAll(text)) {
			if (match.range.isEmpty()) continue
			if (match.range.last < limit) best = match.range
			last = match.range
		}
		return best ?: last
	}

	fun countMatches(text: CharSequence, pattern: Regex): Int =
		pattern.findAll(text).count { !it.range.isEmpty() }

	/**
	 * Replaces every match. With [SearchOptions.regex], `$1`-style group
	 * references in [replacement] are expanded; otherwise it is literal.
	 */
	fun replaceAll(text: CharSequence, pattern: Regex, replacement: String, options: SearchOptions): Pair<String, Int> {
		var count = 0
		val result = pattern.replace(text) { match ->
			if (match.range.isEmpty()) {
				match.value
			} else {
				count++
				if (options.regex) expandGroups(match, replacement) else replacement
			}
		}
		return result to count
	}

	/** The replacement text for a single [match]. */
	fun replacementFor(match: MatchResult, replacement: String, options: SearchOptions): String =
		if (options.regex) expandGroups(match, replacement) else replacement

	private fun firstNonEmpty(pattern: Regex, text: CharSequence, from: Int): IntRange? {
		var match = pattern.find(text, from)
		while (match != null && match.range.isEmpty()) {
			if (match.range.first >= text.length) return null
			match = pattern.find(text, match.range.first + 1)
		}
		return match?.range
	}

	private fun expandGroups(match: MatchResult, replacement: String): String {
		val out = StringBuilder()
		var i = 0
		while (i < replacement.length) {
			val c = replacement[i]
			if (c == '\\' && i + 1 < replacement.length) {
				when (val next = replacement[i + 1]) {
					'n' -> out.append('\n')
					't' -> out.append('\t')
					else -> out.append(next)
				}
				i += 2
				continue
			}
			if (c == '$' && i + 1 < replacement.length && replacement[i + 1].isDigit()) {
				val group = replacement[i + 1].digitToInt()
				out.append(match.groupValues.getOrNull(group) ?: "")
				i += 2
				continue
			}
			out.append(c)
			i++
		}
		return out.toString()
	}
}
