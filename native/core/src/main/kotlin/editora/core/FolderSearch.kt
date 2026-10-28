package editora.core

/** One match inside a file, with a one-line preview for result lists. */
data class LineMatch(
	/** 1-based line and column of the match start. */
	val line: Int,
	val column: Int,
	/** Offsets of the match in the file text. */
	val start: Int,
	val end: Int,
	/** The line (shortened around the match when long). */
	val preview: String,
	/** The match's range inside [preview]. */
	val previewStart: Int,
	val previewEnd: Int,
)

/** Pure helpers for searching every file in a folder. */
object FolderSearch {
	/** Folders that hold dependencies, build output or VCS data, not sources. */
	private val SKIPPED_DIRECTORIES = setOf(
		".git", ".hg", ".svn", "node_modules", "build", "dist", "out", "target",
		".gradle", ".idea", ".next", ".nuxt", ".cache", "__pycache__", ".venv", "venv",
	)

	private val BINARY_EXTENSIONS = setOf(
		"png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "heic", "pdf", "zip", "gz", "tgz",
		"7z", "rar", "jar", "apk", "aab", "so", "class", "dex", "exe", "dll", "bin", "mp3",
		"m4a", "wav", "ogg", "mp4", "mov", "webm", "ttf", "otf", "woff", "woff2", "db", "sqlite",
	)

	private const val PREVIEW_LIMIT = 160
	private const val PREVIEW_CONTEXT = 40

	fun shouldSkipDirectory(name: String): Boolean = name in SKIPPED_DIRECTORIES

	fun shouldSkipFile(name: String): Boolean =
		name.substringAfterLast('.', missingDelimiterValue = "").lowercase() in BINARY_EXTENSIONS

	/** Non-empty matches of [pattern] in [text], at most [limit]. */
	fun findInText(text: String, pattern: Regex, limit: Int): List<LineMatch> {
		if (limit <= 0) return emptyList()
		val results = ArrayList<LineMatch>()
		var line = 1
		var lineStart = 0
		var scanned = 0
		for (match in pattern.findAll(text)) {
			if (match.range.isEmpty()) continue
			val start = match.range.first
			val end = match.range.last + 1
			// Advance the line counter up to this match.
			while (scanned < start) {
				if (text[scanned] == '\n') {
					line++
					lineStart = scanned + 1
				}
				scanned++
			}
			var lineEnd = text.indexOf('\n', start)
			if (lineEnd < 0) lineEnd = text.length
			results += preview(text, line, lineStart, lineEnd, start, end)
			if (results.size >= limit) break
		}
		return results
	}

	private fun preview(text: String, line: Int, lineStart: Int, lineEnd: Int, start: Int, end: Int): LineMatch {
		val matchEndOnLine = minOf(end, lineEnd)
		var from = lineStart
		var to = lineEnd
		if (to - from > PREVIEW_LIMIT) {
			from = maxOf(lineStart, start - PREVIEW_CONTEXT)
			to = minOf(lineEnd, maxOf(matchEndOnLine, from + PREVIEW_LIMIT))
		}
		// Drop leading indentation so previews line up.
		while (from < start && (text[from] == ' ' || text[from] == '\t')) from++
		val prefix = if (from > lineStart && text[from - 1] != ' ' && text[from - 1] != '\t') "…" else ""
		val suffix = if (to < lineEnd) "…" else ""
		val preview = prefix + text.substring(from, to) + suffix
		val previewStart = prefix.length + (start - from)
		val previewEnd = prefix.length + (matchEndOnLine - from)
		return LineMatch(line, start - lineStart + 1, start, end, preview, previewStart, previewEnd)
	}
}
