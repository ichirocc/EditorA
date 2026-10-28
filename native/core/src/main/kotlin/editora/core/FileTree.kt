package editora.core

/** One file or folder as reported by the storage provider. */
data class TreeEntry(val id: String, val name: String, val isDirectory: Boolean)

/** A visible line of the tree. */
data class TreeRow(
	val entry: TreeEntry,
	val parentId: String,
	val depth: Int,
	val expanded: Boolean,
	/** Expanded but its children have not been loaded yet. */
	val loading: Boolean,
)

/**
 * Expand/collapse state of a lazily loaded folder tree.
 *
 * Children are supplied by the caller (who reads them from storage) with
 * [setChildren]; [rows] flattens the expanded part for display.
 */
class FileTree(val rootId: String) {
	private val children = HashMap<String, List<TreeEntry>>()
	private val expanded = LinkedHashSet<String>()

	val expandedIds: Set<String> get() = expanded

	fun isLoaded(id: String): Boolean = id in children

	fun isExpanded(id: String): Boolean = id == rootId || id in expanded

	fun setChildren(parentId: String, entries: List<TreeEntry>) {
		children[parentId] = sort(entries)
	}

	/** Forgets [id]'s loaded children so they are read again. */
	fun invalidate(id: String) {
		children.remove(id)
	}

	fun invalidateAll() {
		children.clear()
	}

	/**
	 * Expands or collapses folder [id]. Returns true when it is now expanded
	 * and its children still have to be loaded.
	 */
	fun toggle(id: String): Boolean {
		if (id in expanded) {
			expanded.remove(id)
			return false
		}
		expanded.add(id)
		return !isLoaded(id)
	}

	fun expand(ids: Collection<String>) {
		expanded.addAll(ids)
	}

	/** Expanded folders whose children are still missing, in display order. */
	fun pendingLoads(): List<String> {
		val pending = ArrayList<String>()
		if (!isLoaded(rootId)) pending += rootId
		for (row in rows()) {
			if (row.loading) pending += row.entry.id
		}
		return pending
	}

	fun rows(): List<TreeRow> {
		val rows = ArrayList<TreeRow>()
		appendRows(rootId, 0, rows, HashSet())
		return rows
	}

	private fun appendRows(parentId: String, depth: Int, out: MutableList<TreeRow>, visiting: MutableSet<String>) {
		// Guards against providers that report a folder inside itself.
		if (!visiting.add(parentId)) return
		for (entry in children[parentId].orEmpty()) {
			val open = entry.isDirectory && entry.id in expanded
			out += TreeRow(entry, parentId, depth, open, loading = open && !isLoaded(entry.id))
			if (open) appendRows(entry.id, depth + 1, out, visiting)
		}
		visiting.remove(parentId)
	}

	companion object {
		/** Folders first, then names in case-insensitive order. */
		fun sort(entries: List<TreeEntry>): List<TreeEntry> =
			entries.sortedWith(
				compareByDescending<TreeEntry> { it.isDirectory }
					.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name }
					.thenBy { it.name },
			)
	}
}
