package editora.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class LexerTest {
	private fun typesOf(text: String, language: Language) =
		Lexer.tokenize(text, language).map { text.substring(it.start, it.end) to it.type }

	@Test
	fun javascriptKeywordsStringsCommentsAndNumbers() {
		val tokens = typesOf("const s = \"a//b\"; // note\nlet n = 42; /* x */", Languages.JAVASCRIPT)
		assertEquals(
			listOf(
				"const" to TokenType.KEYWORD,
				"\"a//b\"" to TokenType.STRING,
				"// note" to TokenType.COMMENT,
				"let" to TokenType.KEYWORD,
				"42" to TokenType.NUMBER,
				"/* x */" to TokenType.COMMENT,
			),
			tokens,
		)
	}

	@Test
	fun templateLiteralSpansLines() {
		val text = "`a\nb` + 'c'"
		val tokens = typesOf(text, Languages.JAVASCRIPT)
		assertEquals(listOf("`a\nb`" to TokenType.STRING, "'c'" to TokenType.STRING), tokens)
	}

	@Test
	fun singleLineStringStopsAtNewlineAndEscapes() {
		val tokens = typesOf("x = \"a\\\"b\nc", Languages.PYTHON)
		assertEquals(listOf("\"a\\\"b" to TokenType.STRING), tokens)
	}

	@Test
	fun unterminatedBlockCommentRunsToEnd() {
		val tokens = typesOf("a /* never closed", Languages.C_FAMILY)
		assertEquals(listOf("/* never closed" to TokenType.COMMENT), tokens)
	}

	@Test
	fun japaneseTextIsNotMistakenForKeywords() {
		val tokens = typesOf("const 名前 = \"日本語\"; // コメント", Languages.JAVASCRIPT)
		assertEquals(
			listOf(
				"const" to TokenType.KEYWORD,
				"\"日本語\"" to TokenType.STRING,
				"// コメント" to TokenType.COMMENT,
			),
			tokens,
		)
	}

	@Test
	fun identifiersContainingDigitsAreNotNumbers() {
		assertTrue(typesOf("abc123 x1", Languages.JAVASCRIPT).isEmpty())
	}

	@Test
	fun sqlKeywordsAreCaseInsensitive() {
		val tokens = typesOf("SELECT a FROM t -- c", Languages.SQL)
		assertEquals(
			listOf("SELECT" to TokenType.KEYWORD, "FROM" to TokenType.KEYWORD, "-- c" to TokenType.COMMENT),
			tokens,
		)
	}

	@Test
	fun markupTagsAttributesAndComments() {
		val tokens = typesOf("<!-- c --><a href=\"x\">t</a>", Languages.MARKUP)
		assertEquals(
			listOf(
				"<!-- c -->" to TokenType.COMMENT,
				"<a" to TokenType.TAG,
				"href" to TokenType.ATTRIBUTE,
				"\"x\"" to TokenType.STRING,
				">" to TokenType.TAG,
				"</a" to TokenType.TAG,
				">" to TokenType.TAG,
			),
			tokens,
		)
	}

	@Test
	fun markdownHeadingsFencesAndInlineCode() {
		val text = "# Title\nuse `code` here\n```\nfenced\n```\n"
		val tokens = typesOf(text, Languages.MARKDOWN)
		assertEquals(
			listOf(
				"# Title" to TokenType.HEADING,
				"`code`" to TokenType.STRING,
				"```\nfenced\n```" to TokenType.STRING,
			),
			tokens,
		)
	}

	@Test
	fun plainTextHasNoTokens() {
		assertTrue(Lexer.tokenize("const x = 1", Languages.PLAIN).isEmpty())
	}

	@Test
	fun tokensAreOrderedAndInBounds() {
		val text = "def f():\n    return \"\"\"doc\n\"\"\" # end"
		var previousEnd = 0
		for (token in Lexer.tokenize(text, Languages.PYTHON)) {
			assertTrue(token.start >= previousEnd && token.end <= text.length && token.start < token.end)
			previousEnd = token.end
		}
	}
}
