package editora.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

class UndoHistoryTest {
	private var now = 0L
	private fun history() = UndoHistory(clock = { now })

	/** Applies [edit] to [text] the way the editor does. */
	private fun apply(text: String, edit: Edit) =
		text.substring(0, edit.start) + edit.inserted + text.substring(edit.start + edit.removed.length)

	@Test
	fun typingIsMergedIntoOneStep() {
		val h = history()
		h.record(Edit(0, "", "a"))
		h.record(Edit(1, "", "b"))
		h.record(Edit(2, "", "c"))
		assertEquals(Edit(0, "abc", ""), h.undo())
		assertNull(h.undo())
	}

	@Test
	fun imeCompositionCollapsesToTheCommittedWord() {
		val h = history()
		var text = "x"
		// Gboard romaji input: k, か, かn, かん, then conversion to 漢.
		for (edit in listOf(
			Edit(1, "", "k"),
			Edit(1, "k", "か"),
			Edit(1, "か", "かn"),
			Edit(1, "かn", "かん"),
			Edit(1, "かん", "漢"),
		)) {
			text = apply(text, edit)
			h.record(edit)
		}
		assertEquals("x漢", text)
		val undo = h.undo()!!
		assertEquals("x", apply(text, undo))
		assertFalse(h.canUndo)
	}

	@Test
	fun pauseStartsANewStep() {
		val h = history()
		h.record(Edit(0, "", "a"))
		now += 5000
		h.record(Edit(1, "", "b"))
		assertEquals(Edit(1, "b", ""), h.undo())
		assertEquals(Edit(0, "a", ""), h.undo())
	}

	@Test
	fun newlineEndsMerging() {
		val h = history()
		h.record(Edit(0, "", "a\n"))
		h.record(Edit(2, "", "b"))
		assertEquals(Edit(2, "b", ""), h.undo())
	}

	@Test
	fun backspacesMerge() {
		val h = history()
		h.record(Edit(2, "c", ""))
		h.record(Edit(1, "b", ""))
		h.record(Edit(0, "a", ""))
		assertEquals(Edit(0, "", "abc"), h.undo())
	}

	@Test
	fun redoReappliesAndNewEditClearsRedo() {
		val h = history()
		h.record(Edit(0, "", "a"))
		val undo = h.undo()!!
		var text = apply("a", undo)
		assertEquals("", text)
		val redo = h.redo()!!
		text = apply(text, redo)
		assertEquals("a", text)
		h.undo()
		h.record(Edit(0, "", "z"))
		assertNull(h.redo())
	}

	@Test
	fun breakMergeSeparatesSteps() {
		val h = history()
		h.record(Edit(0, "", "a"))
		h.breakMerge()
		h.record(Edit(1, "", "b"))
		assertEquals(Edit(1, "b", ""), h.undo())
	}

	@Test
	fun historyIsBounded() {
		val h = UndoHistory(maxSteps = 3, clock = { now })
		repeat(5) {
			h.breakMerge()
			h.record(Edit(it, "", "x"))
		}
		var steps = 0
		while (h.undo() != null) steps++
		assertEquals(3, steps)
	}
}
