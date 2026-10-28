package editora.app

import android.app.AlertDialog
import android.content.Context
import android.graphics.Typeface
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.text.InputType
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.MimeTypeMap
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import editora.core.FileTree
import editora.core.TreeEntry
import editora.core.TreeRow
import java.util.concurrent.ExecutorService

/**
 * Side panel listing a folder chosen with the system picker
 * (ACTION_OPEN_DOCUMENT_TREE). Reads and file operations go through
 * [DocumentsContract] on [io]; results are applied on the main thread.
 */
class FolderPanel(
	context: Context,
	private val io: ExecutorService,
	private val host: Host,
) : LinearLayout(context) {
	interface Host {
		fun onOpenFile(uri: Uri)
		fun onPickFolder()
		fun onFileRenamed(oldUri: Uri, newUri: Uri, newName: String)
		fun onFileDeleted(uri: Uri)
		fun showMessage(message: String)
	}

	private val mainHandler = Handler(Looper.getMainLooper())
	private val title = TextView(context)
	private val emptyView = TextView(context)
	private val list = ListView(context)
	private val adapter = RowAdapter()

	private var treeUri: Uri? = null
	private var tree: FileTree? = null
	private var rows: List<TreeRow> = emptyList()
	private val loadsInFlight = HashSet<String>()

	/** Invoked when the expanded folders change, so the host can persist them. */
	var onExpansionChanged: ((Set<String>) -> Unit)? = null

	init {
		orientation = VERTICAL
		setBackgroundColor(themeColor(android.R.attr.colorBackground))
		elevation = dp(8).toFloat()

		title.apply {
			setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
			setTypeface(typeface, Typeface.BOLD)
			isSingleLine = true
			ellipsize = TextUtils.TruncateAt.MIDDLE
			setPadding(dp(16), dp(12), dp(8), dp(12))
		}
		val header = LinearLayout(context).apply {
			orientation = HORIZONTAL
			gravity = Gravity.CENTER_VERTICAL
			addView(title, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
			addView(smallButton(context.getString(R.string.new_file)) { promptCreate(rootRow(), directory = false) })
			addView(smallButton("↻") { refresh() })
			addView(smallButton("…") { host.onPickFolder() })
		}
		addView(header, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

		emptyView.apply {
			text = context.getString(R.string.folder_none)
			gravity = Gravity.CENTER
			setPadding(dp(24), dp(48), dp(24), dp(24))
			setOnClickListener { host.onPickFolder() }
		}
		addView(emptyView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

		list.adapter = adapter
		list.isFocusable = false
		list.setOnItemClickListener { _, _, position, _ -> onRowClick(rows[position]) }
		list.setOnItemLongClickListener { _, _, position, _ ->
			showRowActions(rows[position])
			true
		}
		addView(list, LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))
		showEmpty()
	}

	val hasFolder: Boolean get() = treeUri != null

	/** Shows [uri] (a tree URI with a persisted grant), re-expanding [expandedIds]. */
	fun setFolder(uri: Uri?, expandedIds: Set<String> = emptySet()) {
		treeUri = uri
		loadsInFlight.clear()
		if (uri == null) {
			tree = null
			showEmpty()
			return
		}
		val rootId = DocumentsContract.getTreeDocumentId(uri)
		tree = FileTree(rootId).apply { expand(expandedIds) }
		emptyView.visibility = GONE
		list.visibility = VISIBLE
		title.text = uri.lastPathSegment?.substringAfterLast(':')?.substringAfterLast('/') ?: ""
		io.execute {
			val name = queryName(DocumentsContract.buildDocumentUriUsingTree(uri, rootId))
			if (name != null) mainHandler.post { if (treeUri == uri) title.text = name }
		}
		render()
	}

	fun refresh() {
		val current = tree ?: return
		current.invalidateAll()
		loadsInFlight.clear()
		render()
	}

	private fun showEmpty() {
		title.text = context.getString(R.string.nav_files)
		rows = emptyList()
		adapter.notifyDataSetChanged()
		emptyView.visibility = VISIBLE
		list.visibility = GONE
	}

	private fun render() {
		val current = tree ?: return
		rows = current.rows()
		adapter.notifyDataSetChanged()
		for (id in current.pendingLoads()) load(id)
	}

	private fun load(parentId: String) {
		val uri = treeUri ?: return
		if (!loadsInFlight.add(parentId)) return
		val current = tree
		io.execute {
			val entries = listChildren(uri, parentId)
			mainHandler.post {
				loadsInFlight.remove(parentId)
				if (tree !== current || current == null) return@post
				if (entries == null) {
					host.showMessage(context.getString(R.string.operation_failed, parentId.substringAfterLast('/')))
					current.setChildren(parentId, emptyList())
				} else {
					current.setChildren(parentId, entries)
				}
				render()
			}
		}
	}

	private fun onRowClick(row: TreeRow) {
		val uri = treeUri ?: return
		val current = tree ?: return
		if (row.entry.isDirectory) {
			current.toggle(row.entry.id)
			onExpansionChanged?.invoke(current.expandedIds)
			render()
		} else {
			host.onOpenFile(DocumentsContract.buildDocumentUriUsingTree(uri, row.entry.id))
		}
	}

	/** A pseudo row for the folder itself, used as the parent for "new file". */
	private fun rootRow(): TreeRow? {
		val current = tree ?: return null
		val entry = TreeEntry(current.rootId, title.text.toString(), isDirectory = true)
		return TreeRow(entry, current.rootId, -1, expanded = true, loading = false)
	}

	private fun showRowActions(row: TreeRow) {
		val actions = ArrayList<Pair<String, () -> Unit>>()
		if (row.entry.isDirectory) {
			actions += context.getString(R.string.new_file) to { promptCreate(row, directory = false) }
			actions += context.getString(R.string.new_folder) to { promptCreate(row, directory = true) }
		}
		actions += context.getString(R.string.rename) to { promptRename(row) }
		actions += context.getString(R.string.delete) to { confirmDelete(row) }
		AlertDialog.Builder(context)
			.setTitle(row.entry.name)
			.setItems(actions.map { it.first }.toTypedArray()) { _, which -> actions[which].second() }
			.show()
	}

	private fun promptCreate(parent: TreeRow?, directory: Boolean) {
		val uri = treeUri ?: run {
			host.onPickFolder()
			return
		}
		parent ?: return
		promptName(context.getString(if (directory) R.string.new_folder else R.string.new_file), "") { name ->
			val parentUri = DocumentsContract.buildDocumentUriUsingTree(uri, parent.entry.id)
			io.execute {
				val created = try {
					DocumentsContract.createDocument(
						context.contentResolver,
						parentUri,
						if (directory) Document.MIME_TYPE_DIR else mimeTypeFor(name),
						name,
					)
				} catch (e: Exception) {
					null
				}
				mainHandler.post {
					if (created == null) {
						host.showMessage(context.getString(R.string.operation_failed, name))
						return@post
					}
					val current = tree ?: return@post
					current.invalidate(parent.entry.id)
					if (parent.depth >= 0 && !current.isExpanded(parent.entry.id)) current.toggle(parent.entry.id)
					onExpansionChanged?.invoke(current.expandedIds)
					render()
					if (!directory) host.onOpenFile(created)
				}
			}
		}
	}

	private fun promptRename(row: TreeRow) {
		val uri = treeUri ?: return
		promptName(context.getString(R.string.rename), row.entry.name) { name ->
			if (name == row.entry.name) return@promptName
			val oldUri = DocumentsContract.buildDocumentUriUsingTree(uri, row.entry.id)
			io.execute {
				val renamed = try {
					DocumentsContract.renameDocument(context.contentResolver, oldUri, name)
				} catch (e: Exception) {
					null
				}
				mainHandler.post {
					if (renamed == null) {
						host.showMessage(context.getString(R.string.operation_failed, name))
						return@post
					}
					if (!row.entry.isDirectory) host.onFileRenamed(oldUri, renamed, name)
					tree?.invalidate(row.parentId)
					render()
				}
			}
		}
	}

	private fun confirmDelete(row: TreeRow) {
		val uri = treeUri ?: return
		AlertDialog.Builder(context)
			.setMessage(context.getString(R.string.delete_confirm, row.entry.name))
			.setPositiveButton(R.string.delete) { _, _ ->
				val docUri = DocumentsContract.buildDocumentUriUsingTree(uri, row.entry.id)
				io.execute {
					val deleted = try {
						DocumentsContract.deleteDocument(context.contentResolver, docUri)
					} catch (e: Exception) {
						false
					}
					mainHandler.post {
						if (!deleted) {
							host.showMessage(context.getString(R.string.operation_failed, row.entry.name))
							return@post
						}
						if (!row.entry.isDirectory) host.onFileDeleted(docUri)
						tree?.invalidate(row.parentId)
						render()
					}
				}
			}
			.setNegativeButton(R.string.action_cancel, null)
			.show()
	}

	private fun promptName(title: String, initial: String, onName: (String) -> Unit) {
		val input = EditText(context).apply {
			setText(initial)
			isSingleLine = true
			inputType = InputType.TYPE_CLASS_TEXT
			hint = context.getString(R.string.name_hint)
			// Select the name without its extension, as file managers do.
			val dot = initial.lastIndexOf('.')
			setSelection(0, if (dot > 0) dot else initial.length)
		}
		val container = LinearLayout(context).apply {
			setPadding(dp(20), dp(8), dp(20), 0)
			addView(input, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
		}
		AlertDialog.Builder(context)
			.setTitle(title)
			.setView(container)
			.setPositiveButton(android.R.string.ok) { _, _ ->
				val name = input.text.toString().trim()
				if (isValidName(name)) onName(name) else host.showMessage(context.getString(R.string.operation_failed, name))
			}
			.setNegativeButton(R.string.action_cancel, null)
			.show()
		input.requestFocus()
	}

	private fun isValidName(name: String) = name.isNotEmpty() && name != "." && name != ".." && '/' !in name

	/** Lists a folder's children, or null if the provider refused. Runs on [io]. */
	private fun listChildren(tree: Uri, parentId: String): List<TreeEntry>? {
		val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
		val projection = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE)
		return try {
			context.contentResolver.query(childrenUri, projection, null, null, null)?.use { cursor ->
				val entries = ArrayList<TreeEntry>(cursor.count)
				while (cursor.moveToNext()) {
					val id = cursor.getString(0) ?: continue
					val name = cursor.getString(1) ?: id.substringAfterLast('/')
					entries += TreeEntry(id, name, cursor.getString(2) == Document.MIME_TYPE_DIR)
				}
				entries
			}
		} catch (e: Exception) {
			null
		}
	}

	private fun queryName(documentUri: Uri): String? = try {
		context.contentResolver.query(documentUri, arrayOf(Document.COLUMN_DISPLAY_NAME), null, null, null)?.use {
			if (it.moveToFirst()) it.getString(0) else null
		}
	} catch (e: Exception) {
		null
	}

	private inner class RowAdapter : BaseAdapter() {
		override fun getCount() = rows.size
		override fun getItem(position: Int) = rows[position]
		override fun getItemId(position: Int) = position.toLong()

		override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
			val view = convertView as? TextView ?: TextView(context).apply {
				isSingleLine = true
				ellipsize = TextUtils.TruncateAt.END
				setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
				gravity = Gravity.CENTER_VERTICAL
				minHeight = dp(40)
			}
			val row = rows[position]
			val marker = when {
				!row.entry.isDirectory -> "   "
				row.loading -> "… "
				row.expanded -> "▾ "
				else -> "▸ "
			}
			view.text = marker + row.entry.name
			view.setTypeface(Typeface.DEFAULT, if (row.entry.isDirectory) Typeface.BOLD else Typeface.NORMAL)
			view.setPadding(dp(12 + row.depth * 16), 0, dp(12), 0)
			return view
		}
	}

	private fun smallButton(label: String, onClick: () -> Unit) =
		Button(context, null, android.R.attr.borderlessButtonStyle).apply {
			text = label
			isAllCaps = false
			minWidth = dp(40)
			minimumWidth = dp(40)
			isFocusable = false
			setOnClickListener { onClick() }
		}

	private fun mimeTypeFor(name: String): String {
		val extension = name.substringAfterLast('.', missingDelimiterValue = "").lowercase()
		return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "application/octet-stream"
	}

	private fun themeColor(attr: Int): Int {
		val value = TypedValue()
		context.theme.resolveAttribute(attr, value, true)
		return if (value.resourceId != 0) context.getColor(value.resourceId) else value.data
	}

	private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
}
