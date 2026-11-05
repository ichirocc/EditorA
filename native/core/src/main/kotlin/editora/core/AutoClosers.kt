package editora.core

/**
 * Offsets of closing brackets and quotes that auto-close inserted, kept in
 * step with later edits. Typing a closer steps over the one already after
 * the cursor only when auto-close put it there, so closers the user typed or
 * that were already in the file can always be typed again.
 */
class AutoClosers {
	private val offsets = mutableListOf<Int>()

	/** Records that auto-close inserted a closer at [offset]. */
	fun added(offset: Int) {
		offsets.add(offset)
	}

	/** True when the closer at [offset] was inserted by auto-close. */
	fun isTracked(offset: Int): Boolean = offset in offsets

	/** Forgets the closer at [offset] (it was stepped over); true if it was tracked. */
	fun consume(offset: Int): Boolean = offsets.remove(offset)

	/**
	 * Follows a replacement of [removed] characters at [start] by [inserted]
	 * characters: closers inside the replaced range are dropped, later ones shift.
	 */
	fun onEdit(start: Int, removed: Int, inserted: Int) {
		if (offsets.isEmpty()) return
		val end = start + removed
		val iterator = offsets.listIterator()
		while (iterator.hasNext()) {
			val offset = iterator.next()
			when {
				offset >= end -> iterator.set(offset + inserted - removed)
				offset >= start -> iterator.remove()
			}
		}
	}

	fun clear() {
		offsets.clear()
	}
}
