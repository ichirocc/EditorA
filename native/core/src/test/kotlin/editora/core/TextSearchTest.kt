package editora.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class TextSearchTest {
	@Test
	fun findNextWrapsAround() {
		val p = TextSearch.pattern("ab", SearchOptions())!!
		assertEquals(4..5, TextSearch.findNext("ab__ab", p, 1))
		assertEquals(0..1, TextSearch.findNext("ab__ab", p, 5))
	}

	@Test
	fun findPreviousWrapsAround() {
		val p = TextSearch.pattern("ab", SearchOptions())!!
		assertEquals(0..1, TextSearch.findPrevious("ab__ab", p, 4))
		assertEquals(4..5, TextSearch.findPrevious("ab__ab", p, 0))
	}

	@Test
	fun caseAndWholeWordOptions() {
		val text = "Cat cat category"
		assertEquals(3, TextSearch.countMatches(text, TextSearch.pattern("cat", SearchOptions())!!))
		assertEquals(2, TextSearch.countMatches(text, TextSearch.pattern("cat", SearchOptions(matchCase = true))!!))
		assertEquals(2, TextSearch.countMatches(text, TextSearch.pattern("cat", SearchOptions(wholeWord = true))!!))
	}

	@Test
	fun literalQueryEscapesRegexCharacters() {
		val p = TextSearch.pattern("a.b", SearchOptions())!!
		assertEquals(1, TextSearch.countMatches("a.b axb", p))
	}

	@Test
	fun invalidRegexAndEmptyQueryGiveNoPattern() {
		assertNull(TextSearch.pattern("(", SearchOptions(regex = true)))
		assertNull(TextSearch.pattern("", SearchOptions()))
	}

	@Test
	fun japaneseSearch() {
		val p = TextSearch.pattern("日本", SearchOptions())!!
		assertEquals(3..4, TextSearch.findNext("これは日本語", p, 0))
	}

	@Test
	fun replaceAllLiteralAndRegexGroups() {
		val literal = SearchOptions()
		val (a, n) = TextSearch.replaceAll("x=1 x=2", TextSearch.pattern("x", literal)!!, "$1", literal)
		assertEquals("$1=1 $1=2" to 2, a to n)

		val regex = SearchOptions(regex = true)
		val (b, m) = TextSearch.replaceAll("x=1 y=2", TextSearch.pattern("(\\w)=(\\d)", regex)!!, "$2:$1", regex)
		assertEquals("1:x 2:y" to 2, b to m)
	}

	@Test
	fun emptyMatchesAreSkipped() {
		val regex = SearchOptions(regex = true)
		val p = TextSearch.pattern("x*", regex)!!
		assertEquals(1..2, TextSearch.findNext("axx", p, 0))
		assertEquals(1, TextSearch.countMatches("axx", p))
	}
}
