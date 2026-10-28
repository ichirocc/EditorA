package editora.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class FolderSearchTest {
	private fun pattern(query: String, options: SearchOptions = SearchOptions()) = TextSearch.pattern(query, options)!!

	@Test
	fun reportsLineColumnOffsetsAndPreview() {
		val text = "first\n    let 名前 = 1\nlast 名前"
		val matches = FolderSearch.findInText(text, pattern("名前"), 10)
		assertEquals(2, matches.size)

		val first = matches[0]
		assertEquals(2, first.line)
		assertEquals(9, first.column)
		assertEquals("名前", text.substring(first.start, first.end))
		assertEquals("let 名前 = 1", first.preview)
		assertEquals("名前", first.preview.substring(first.previewStart, first.previewEnd))

		val second = matches[1]
		assertEquals(3, second.line)
		assertEquals(6, second.column)
	}

	@Test
	fun respectsLimitAndSkipsEmptyMatches() {
		val text = "a a a a"
		assertEquals(2, FolderSearch.findInText(text, pattern("a"), 2).size)
		assertTrue(FolderSearch.findInText(text, pattern("x*", SearchOptions(regex = true)), 5).isEmpty())
	}

	@Test
	fun longLinesAreShortenedAroundTheMatch() {
		val text = "x".repeat(500) + "needle" + "y".repeat(500)
		val match = FolderSearch.findInText(text, pattern("needle"), 1).single()
		assertTrue(match.preview.length < 220)
		assertTrue(match.preview.startsWith("…") && match.preview.endsWith("…"))
		assertEquals("needle", match.preview.substring(match.previewStart, match.previewEnd))
	}

	@Test
	fun multilineMatchPreviewStopsAtLineEnd() {
		val text = "ab\ncd"
		val match = FolderSearch.findInText(text, pattern("b\\nc", SearchOptions(regex = true)), 1).single()
		assertEquals("ab", match.preview)
		assertEquals("b", match.preview.substring(match.previewStart, match.previewEnd))
	}

	@Test
	fun skipsDependencyFoldersAndBinaryFiles() {
		assertTrue(FolderSearch.shouldSkipDirectory("node_modules"))
		assertTrue(FolderSearch.shouldSkipDirectory(".git"))
		assertFalse(FolderSearch.shouldSkipDirectory("src"))
		assertTrue(FolderSearch.shouldSkipFile("logo.PNG"))
		assertFalse(FolderSearch.shouldSkipFile("main.kt"))
		assertFalse(FolderSearch.shouldSkipFile("Makefile"))
	}
}
