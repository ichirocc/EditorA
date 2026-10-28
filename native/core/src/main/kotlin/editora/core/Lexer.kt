package editora.core

enum class TokenType { KEYWORD, STRING, NUMBER, COMMENT, TAG, ATTRIBUTE, HEADING }

/** A coloured range `[start, end)` of the source text. */
data class Token(val start: Int, val end: Int, val type: TokenType)

/**
 * Single-pass, allocation-light tokenizer.
 *
 * It is deliberately approximate: the goal is readable colouring of the
 * whole file in linear time, not a full parse.
 */
object Lexer {
	fun tokenize(text: CharSequence, language: Language): List<Token> = when (language.kind) {
		LexerKind.PLAIN -> emptyList()
		LexerKind.CODE -> tokenizeCode(text, language)
		LexerKind.MARKUP -> tokenizeMarkup(text)
		LexerKind.MARKDOWN -> tokenizeMarkdown(text)
	}

	private fun tokenizeCode(text: CharSequence, language: Language): List<Token> {
		val tokens = ArrayList<Token>()
		val length = text.length
		var i = 0
		while (i < length) {
			val c = text[i]

			val block = language.blockComment
			if (block != null && text.startsWithAt(block.first, i)) {
				val end = text.indexOfFrom(block.second, i + block.first.length)
				val stop = if (end < 0) length else end + block.second.length
				tokens += Token(i, stop, TokenType.COMMENT)
				i = stop
				continue
			}

			val lineComment = language.lineComments.firstOrNull { text.startsWithAt(it, i) }
			if (lineComment != null) {
				val stop = text.lineEndFrom(i)
				tokens += Token(i, stop, TokenType.COMMENT)
				i = stop
				continue
			}

			val multiline = language.multilineDelimiters.firstOrNull { text.startsWithAt(it, i) }
			if (multiline != null) {
				val stop = scanString(text, i + multiline.length, multiline, allowNewline = true)
				tokens += Token(i, stop, TokenType.STRING)
				i = stop
				continue
			}

			if (c in language.stringDelimiters) {
				val stop = scanString(text, i + 1, c.toString(), allowNewline = false)
				tokens += Token(i, stop, TokenType.STRING)
				i = stop
				continue
			}

			if (c.isDigit() && (i == 0 || !text[i - 1].isIdentifierPart())) {
				var j = i + 1
				while (j < length && (text[j].isLetterOrDigit() || text[j] == '.' || text[j] == '_')) j++
				tokens += Token(i, j, TokenType.NUMBER)
				i = j
				continue
			}

			if (c.isIdentifierStart()) {
				var j = i + 1
				while (j < length && text[j].isIdentifierPart()) j++
				if (language.isKeyword(text.substring(i, j))) {
					tokens += Token(i, j, TokenType.KEYWORD)
				}
				i = j
				continue
			}

			i++
		}
		return tokens
	}

	/** Returns the index just past the closing [delimiter], honouring backslash escapes. */
	private fun scanString(text: CharSequence, from: Int, delimiter: String, allowNewline: Boolean): Int {
		var j = from
		while (j < text.length) {
			val c = text[j]
			if (c == '\\') {
				j += 2
				continue
			}
			if (text.startsWithAt(delimiter, j)) return j + delimiter.length
			if (c == '\n' && !allowNewline) return j
			j++
		}
		return text.length
	}

	private fun tokenizeMarkup(text: CharSequence): List<Token> {
		val tokens = ArrayList<Token>()
		val length = text.length
		var i = 0
		while (i < length) {
			if (text.startsWithAt("<!--", i)) {
				val end = text.indexOfFrom("-->", i + 4)
				val stop = if (end < 0) length else end + 3
				tokens += Token(i, stop, TokenType.COMMENT)
				i = stop
				continue
			}
			if (text[i] != '<') {
				i++
				continue
			}

			// Tag name, including "</", "<!" and "<?" prefixes.
			var j = i + 1
			while (j < length && (text[j] == '/' || text[j] == '!' || text[j] == '?')) j++
			val nameStart = j
			while (j < length && (text[j].isLetterOrDigit() || text[j] in "-_:.")) j++
			if (j == nameStart) {
				i++
				continue
			}
			tokens += Token(i, j, TokenType.TAG)

			// Attributes until the closing '>'.
			while (j < length && text[j] != '>') {
				val c = text[j]
				when {
					c == '"' || c == '\'' -> {
						val close = text.indexOfFrom(c.toString(), j + 1)
						val stop = if (close < 0) length else close + 1
						tokens += Token(j, stop, TokenType.STRING)
						j = stop
					}
					c.isLetter() -> {
						val start = j
						while (j < length && (text[j].isLetterOrDigit() || text[j] in "-_:@.")) j++
						tokens += Token(start, j, TokenType.ATTRIBUTE)
					}
					c == '<' -> break
					else -> j++
				}
			}
			if (j < length && text[j] == '>') {
				tokens += Token(j, j + 1, TokenType.TAG)
				j++
			}
			i = j
		}
		return tokens
	}

	private fun tokenizeMarkdown(text: CharSequence): List<Token> {
		val tokens = ArrayList<Token>()
		val length = text.length
		var lineStart = 0
		var inFence = false
		var fenceStart = 0
		while (lineStart < length) {
			val lineEnd = text.lineEndFrom(lineStart)
			val trimmedStart = text.firstNonSpace(lineStart, lineEnd)
			val isFence = text.startsWithAt("```", trimmedStart) || text.startsWithAt("~~~", trimmedStart)

			if (isFence) {
				if (inFence) {
					tokens += Token(fenceStart, lineEnd, TokenType.STRING)
				} else {
					fenceStart = lineStart
				}
				inFence = !inFence
			} else if (!inFence) {
				if (trimmedStart < lineEnd && text[trimmedStart] == '#') {
					tokens += Token(lineStart, lineEnd, TokenType.HEADING)
				} else if (trimmedStart < lineEnd && text[trimmedStart] == '>') {
					tokens += Token(lineStart, lineEnd, TokenType.COMMENT)
				} else {
					addInlineCode(text, lineStart, lineEnd, tokens)
				}
			}
			lineStart = lineEnd + 1
		}
		if (inFence) tokens += Token(fenceStart, length, TokenType.STRING)
		return tokens
	}

	private fun addInlineCode(text: CharSequence, from: Int, to: Int, tokens: MutableList<Token>) {
		var i = from
		while (i < to) {
			if (text[i] == '`') {
				var j = i + 1
				while (j < to && text[j] != '`') j++
				if (j < to) {
					tokens += Token(i, j + 1, TokenType.STRING)
					i = j + 1
					continue
				}
			}
			i++
		}
	}
}

private fun Char.isIdentifierStart() = isLetter() || this == '_' || this == '$'

private fun Char.isIdentifierPart() = isLetterOrDigit() || this == '_' || this == '$'

internal fun CharSequence.startsWithAt(prefix: String, index: Int): Boolean {
	if (index < 0 || index + prefix.length > length) return false
	for (k in prefix.indices) if (this[index + k] != prefix[k]) return false
	return true
}

internal fun CharSequence.indexOfFrom(needle: String, from: Int): Int {
	var i = from
	val last = length - needle.length
	while (i <= last) {
		if (startsWithAt(needle, i)) return i
		i++
	}
	return -1
}

internal fun CharSequence.lineEndFrom(from: Int): Int {
	var i = from
	while (i < length && this[i] != '\n') i++
	return i
}

private fun CharSequence.firstNonSpace(from: Int, to: Int): Int {
	var i = from
	while (i < to && (this[i] == ' ' || this[i] == '\t')) i++
	return i
}
