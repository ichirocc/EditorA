package editora.core

/** One text replacement: [removed] at [start] was replaced by [inserted]. */
data class Edit(val start: Int, val removed: String, val inserted: String)

/**
 * Linear undo/redo stack.
 *
 * Consecutive typing is merged into one step, and so is the stream of
 * replacements an IME produces while composing (for example
 * "k" -> "か" -> "かん" -> "漢"), so one undo removes the whole word.
 */
class UndoHistory(
	private val maxSteps: Int = 1000,
	private val mergeWindowMillis: Long = 1500,
	private val clock: () -> Long = System::currentTimeMillis,
) {
	private val undoStack = ArrayDeque<Edit>()
	private val redoStack = ArrayDeque<Edit>()
	private var lastRecordedAt = 0L
	private var mergeAllowed = false

	val canUndo: Boolean get() = undoStack.isNotEmpty()
	val canRedo: Boolean get() = redoStack.isNotEmpty()

	fun record(edit: Edit) {
		if (edit.removed.isEmpty() && edit.inserted.isEmpty()) return
		redoStack.clear()
		val now = clock()
		val last = undoStack.lastOrNull()
		val merged = if (last != null && mergeAllowed && now - lastRecordedAt <= mergeWindowMillis) {
			merge(last, edit)
		} else {
			null
		}
		if (merged != null) {
			undoStack[undoStack.lastIndex] = merged
		} else {
			undoStack.addLast(edit)
			while (undoStack.size > maxSteps) undoStack.removeFirst()
		}
		lastRecordedAt = now
		mergeAllowed = !edit.inserted.contains('\n')
	}

	/** Prevents the next edit from merging into the previous step. */
	fun breakMerge() {
		mergeAllowed = false
	}

	/** Returns the edit that reverts the last step, to be applied to the text. */
	fun undo(): Edit? {
		val edit = undoStack.removeLastOrNull() ?: return null
		redoStack.addLast(edit)
		mergeAllowed = false
		return Edit(edit.start, edit.inserted, edit.removed)
	}

	/** Returns the edit that re-applies the last undone step. */
	fun redo(): Edit? {
		val edit = redoStack.removeLastOrNull() ?: return null
		undoStack.addLast(edit)
		mergeAllowed = false
		return edit
	}

	fun clear() {
		undoStack.clear()
		redoStack.clear()
		mergeAllowed = false
	}

	private fun merge(last: Edit, next: Edit): Edit? {
		val lastEnd = last.start + last.inserted.length

		// Plain typing right after the previous insertion.
		if (next.removed.isEmpty() && next.start == lastEnd) {
			return last.copy(inserted = last.inserted + next.inserted)
		}

		// Replacing (part of) the text the previous step inserted, as an IME
		// does while composing, or backspacing over it.
		val offset = next.start - last.start
		if (
			offset >= 0 &&
			next.start + next.removed.length == lastEnd &&
			last.inserted.regionMatches(offset, next.removed, 0, next.removed.length)
		) {
			return last.copy(inserted = last.inserted.substring(0, offset) + next.inserted)
		}

		// Backspacing before the previous step's start, with nothing inserted.
		if (
			next.inserted.isEmpty() &&
			last.inserted.isEmpty() &&
			next.start + next.removed.length == last.start
		) {
			return Edit(next.start, next.removed + last.removed, "")
		}
		return null
	}
}
