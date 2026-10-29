package editora.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class EditOpsTest {
	private fun apply(text: String, result: EditResult?): String {
		val edit = result!!.edit
		return text.substring(0, edit.start) + edit.inserted + text.substring(edit.start + edit.removed.length)
	}

	@Test
	fun toggleLineCommentAtCommonIndent() {
		val text = "fun a() {\n    val x = 1\n\n    // keep\n    y()\n}"
		val from = text.indexOf("    val")
		val to = text.indexOf("y()") + 1
		val commented = apply(text, EditOps.toggleComment(text, from, to, Languages.KOTLIN_JAVA))
		assertEquals("fun a() {\n    // val x = 1\n\n    // // keep\n    // y()\n}", commented)

		val from2 = commented.indexOf("    // val")
		val to2 = commented.indexOf("y()") + 1
		assertEquals(text, apply(commented, EditOps.toggleComment(commented, from2, to2, Languages.KOTLIN_JAVA)))
	}

	@Test
	fun toggleCommentUsesLanguageMarkers() {
		assertEquals("# 日本語", apply("日本語", EditOps.toggleComment("日本語", 0, 0, Languages.PYTHON)))
		assertEquals("-- select", apply("select", EditOps.toggleComment("select", 0, 0, Languages.SQL)))
		assertEquals("<!-- <p>x</p> -->", apply("<p>x</p>", EditOps.toggleComment("<p>x</p>", 0, 0, Languages.MARKUP)))
		assertEquals("<p>x</p>", apply("<!-- <p>x</p> -->", EditOps.toggleComment("<!-- <p>x</p> -->", 0, 0, Languages.MARKUP)))
		assertEquals("/* a {} */", apply("a {}", EditOps.toggleComment("a {}", 0, 0, Languages.CSS)))
		assertNull(EditOps.toggleComment("text", 0, 0, Languages.PLAIN))
	}

	@Test
	fun selectionEndingAtLineStartExcludesThatLine() {
		val text = "a\nb\nc"
		// Selecting "a\n" (cursor at start of "b") comments only line a.
		assertEquals("// a\nb\nc", apply(text, EditOps.toggleComment(text, 0, 2, Languages.JAVASCRIPT)))
	}

	@Test
	fun indentAndOutdent() {
		val text = "a\n\n  b"
		val indented = apply(text, EditOps.indent(text, 0, text.length, "    "))
		assertEquals("    a\n\n      b", indented)
		assertEquals("a\n\n  b", apply(indented, EditOps.outdent(indented, 0, indented.length, "    ")))
		assertEquals("x", apply("\tx", EditOps.outdent("\tx", 0, 0, "    ")))
	}

	@Test
	fun indentKeepsBareCursorOnItsCharacter() {
		val result = EditOps.indent("ab", 1, 1, "  ")
		assertEquals("  ab", apply("ab", result))
		assertEquals(3, result.selectionStart)
		val back = EditOps.outdent("  ab", 3, 3, "  ")
		assertEquals(1, back.selectionStart)
	}

	@Test
	fun duplicateLines() {
		val result = EditOps.duplicateLines("x\n日本\ny", 3, 3)
		assertEquals("x\n日本\n日本\ny", apply("x\n日本\ny", result))
		assertEquals(6, result.selectionStart)
	}

	@Test
	fun moveLinesUpAndDownWithSelection() {
		val text = "1\n2\n3"
		val down = EditOps.moveLines(text, 0, 0, up = false)
		assertEquals("2\n1\n3", apply(text, down))
		assertEquals(2, down!!.selectionStart)

		val up = EditOps.moveLines(text, 4, 4, up = true)
		assertEquals("1\n3\n2", apply(text, up))
		assertEquals(2, up!!.selectionStart)

		assertNull(EditOps.moveLines(text, 0, 0, up = true))
		assertNull(EditOps.moveLines(text, 4, 4, up = false))
	}

	@Test
	fun autoClosePairs() {
		assertEquals(')', EditOps.autoCloseFor('(', null, null))
		assertEquals('}', EditOps.autoCloseFor('{', ' ', '\n'))
		assertEquals(']', EditOps.autoCloseFor('[', 'a', ')'))
		// Not before a word, and quotes not after letters (apostrophes).
		assertNull(EditOps.autoCloseFor('(', null, 'x'))
		assertNull(EditOps.autoCloseFor('\'', 't', ' '))
		assertEquals('"', EditOps.autoCloseFor('"', '=', null))
		assertNull(EditOps.autoCloseFor('a', null, null))
	}

	@Test
	fun skipsOverMatchingCloser() {
		assertTrue(EditOps.shouldSkipCloser(')', ')'))
		assertTrue(EditOps.shouldSkipCloser('"', '"'))
		assertFalse(EditOps.shouldSkipCloser(')', ']'))
		assertFalse(EditOps.shouldSkipCloser('(', '('))
	}
}
