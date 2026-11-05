package editora.core

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AutoClosersTest {
	@Test
	fun onlyInsertedClosersAreTracked() {
		val closers = AutoClosers()
		// "foo(" typed, auto-close put ")" at 4.
		closers.added(4)
		assertTrue(closers.isTracked(4))
		// A ")" already in the file (or typed by the user) is not.
		assertFalse(closers.isTracked(8))
	}

	@Test
	fun typingBeforeTheCloserShiftsIt() {
		val closers = AutoClosers()
		closers.added(4)
		// "bar" typed at 4: ")" is now at 7.
		closers.onEdit(start = 4, removed = 0, inserted = 3)
		assertFalse(closers.isTracked(4))
		assertTrue(closers.isTracked(7))
		// Text after the closer does not move it.
		closers.onEdit(start = 9, removed = 0, inserted = 2)
		assertTrue(closers.isTracked(7))
	}

	@Test
	fun deletingTheCloserForgetsIt() {
		val closers = AutoClosers()
		closers.added(4)
		closers.onEdit(start = 3, removed = 2, inserted = 0)
		assertFalse(closers.isTracked(4))
		assertFalse(closers.isTracked(3))
	}

	@Test
	fun steppingOverConsumesTheCloser() {
		val closers = AutoClosers()
		closers.added(4)
		closers.added(5)
		assertTrue(closers.consume(4))
		assertFalse(closers.isTracked(4))
		assertTrue(closers.isTracked(5))
		assertFalse(closers.consume(9))
	}
}
