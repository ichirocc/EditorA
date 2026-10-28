package editora.app

import android.content.Context
import android.graphics.Typeface
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.text.InputType
import android.text.SpannableString
import android.text.Spanned
import android.text.TextUtils
import android.text.style.BackgroundColorSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.BaseAdapter
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import editora.core.DecodeResult
import editora.core.FolderSearch
import editora.core.LineMatch
import editora.core.SearchOptions
import editora.core.TextFiles
import editora.core.TextSearch
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * Searches every text file under the folder panel's tree.
 *
 * The walk runs on its own thread so it never delays opening or saving
 * files. Starting a new search (or [cancel]) abandons the previous one.
 */
class FolderSearchView(
	context: Context,
	private val onOpenMatch: (uri: Uri, start: Int, end: Int) -> Unit,
) : LinearLayout(context) {
	private sealed class Row {
		class FileHeader(val path: String, val count: Int) : Row()
		class Match(val uri: Uri, val match: LineMatch) : Row()
	}

	private val mainHandler = Handler(Looper.getMainLooper())
	private val worker = Executors.newSingleThreadExecutor()
	private val generation = AtomicInteger()

	private val query = EditText(context)
	private val matchCase = CheckBox(context)
	private val wholeWord = CheckBox(context)
	private val regex = CheckBox(context)
	private val status = TextView(context)
	private val results = ListView(context)
	private val rows = ArrayList<Row>()
	private val adapter = RowAdapter()
	private val matchColor = SyntaxColors.forResources(resources).searchMatch

	/** The folder to search; changing it clears old results. */
	var treeUri: Uri? = null
		set(value) {
			if (field == value) return
			field = value
			cancel()
			rows.clear()
			adapter.notifyDataSetChanged()
			status.text = ""
		}

	init {
		orientation = VERTICAL
		query.apply {
			hint = context.getString(R.string.search_in_folder)
			isSingleLine = true
			inputType = InputType.TYPE_CLASS_TEXT
			imeOptions = EditorInfo.IME_ACTION_SEARCH
			setOnEditorActionListener { _, actionId, event ->
				val isEnter = event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
				if (actionId == EditorInfo.IME_ACTION_SEARCH || isEnter) {
					search()
					true
				} else {
					false
				}
			}
		}
		addView(query, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
			setMargins(dp(8), 0, dp(8), 0)
		})

		matchCase.text = context.getString(R.string.match_case)
		wholeWord.text = context.getString(R.string.whole_word)
		regex.text = context.getString(R.string.regex)
		val options = LinearLayout(context).apply {
			orientation = HORIZONTAL
			gravity = Gravity.CENTER_VERTICAL
			setPadding(dp(8), 0, dp(8), 0)
			for (box in listOf(matchCase, wholeWord, regex)) {
				box.setOnCheckedChangeListener { _, _ -> if (query.text.isNotEmpty()) search() }
				addView(box)
			}
		}
		addView(options, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

		status.setPadding(dp(16), dp(2), dp(16), dp(4))
		status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
		addView(status, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

		results.adapter = adapter
		results.isFocusable = false
		results.setOnItemClickListener { _, _, position, _ ->
			val row = rows[position] as? Row.Match ?: return@setOnItemClickListener
			onOpenMatch(row.uri, row.match.start, row.match.end)
		}
		addView(results, LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))
	}

	fun focusQuery() {
		query.requestFocus()
		query.selectAll()
	}

	fun cancel() {
		generation.incrementAndGet()
	}

	fun release() {
		cancel()
		worker.shutdownNow()
	}

	private fun search() {
		val tree = treeUri
		if (tree == null) {
			status.text = context.getString(R.string.search_no_folder)
			return
		}
		val text = query.text.toString()
		if (text.isEmpty()) return
		val pattern = TextSearch.pattern(text, SearchOptions(matchCase.isChecked, wholeWord.isChecked, regex.isChecked))
		if (pattern == null) {
			status.text = context.getString(R.string.invalid_regex)
			return
		}
		val gen = generation.incrementAndGet()
		rows.clear()
		adapter.notifyDataSetChanged()
		status.text = context.getString(R.string.searching, 0)
		worker.execute { walk(tree, pattern, gen) }
	}

	/** Depth-first walk of the tree on the worker thread. */
	private fun walk(tree: Uri, pattern: Regex, gen: Int) {
		val pending = ArrayDeque<Pair<String, String>>() // document id, display path
		pending.addLast(DocumentsContract.getTreeDocumentId(tree) to "")
		var files = 0
		var matches = 0
		var lastProgress = 0L
		while (pending.isNotEmpty()) {
			if (generation.get() != gen) return
			val (parentId, parentPath) = pending.removeLast()
			val children = listChildren(tree, parentId) ?: continue
			// Reverse so the stack visits children in name order.
			for (child in children.sortedByDescending { it.name.lowercase() }) {
				val path = if (parentPath.isEmpty()) child.name else "$parentPath/${child.name}"
				if (child.isDirectory) {
					if (!FolderSearch.shouldSkipDirectory(child.name)) pending.addLast(child.id to path)
					continue
				}
				if (FolderSearch.shouldSkipFile(child.name) || child.size > MAX_FILE_BYTES) continue
				if (generation.get() != gen) return
				val uri = DocumentsContract.buildDocumentUriUsingTree(tree, child.id)
				val text = readText(uri) ?: continue
				files++
				val found = FolderSearch.findInText(text, pattern, MAX_MATCHES - matches)
				matches += found.size
				val now = System.currentTimeMillis()
				if (found.isNotEmpty() || now - lastProgress > 300) {
					lastProgress = now
					val scanned = files
					mainHandler.post {
						if (generation.get() != gen) return@post
						if (found.isNotEmpty()) {
							rows += Row.FileHeader(path, found.size)
							found.forEach { rows += Row.Match(uri, it) }
							adapter.notifyDataSetChanged()
						}
						status.text = context.getString(R.string.searching, scanned)
					}
				}
				if (matches >= MAX_MATCHES) {
					postDone(gen, files, matches, limited = true)
					return
				}
			}
		}
		postDone(gen, files, matches, limited = false)
	}

	private fun postDone(gen: Int, files: Int, matches: Int, limited: Boolean) {
		mainHandler.post {
			if (generation.get() != gen) return@post
			status.text = when {
				limited -> context.getString(R.string.search_limited, matches)
				matches == 0 -> context.getString(R.string.no_match)
				else -> context.getString(R.string.search_done, matches, files)
			}
		}
	}

	private class Child(val id: String, val name: String, val isDirectory: Boolean, val size: Long)

	private fun listChildren(tree: Uri, parentId: String): List<Child>? {
		val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
		val projection = arrayOf(
			Document.COLUMN_DOCUMENT_ID,
			Document.COLUMN_DISPLAY_NAME,
			Document.COLUMN_MIME_TYPE,
			Document.COLUMN_SIZE,
		)
		return try {
			context.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
				val children = ArrayList<Child>(cursor.count)
				while (cursor.moveToNext()) {
					val id = cursor.getString(0) ?: continue
					val name = cursor.getString(1) ?: id.substringAfterLast('/')
					val size = if (cursor.isNull(3)) -1L else cursor.getLong(3)
					children += Child(id, name, cursor.getString(2) == Document.MIME_TYPE_DIR, size)
				}
				children
			}
		} catch (_: Exception) {
			null
		}
	}

	/** Reads and decodes a file, or null if it is too large, binary or not text. */
	private fun readText(uri: Uri): String? {
		try {
			val input = context.contentResolver.openInputStream(uri) ?: return null
			input.use {
			val out = ByteArrayOutputStream()
			val buffer = ByteArray(64 * 1024)
			while (true) {
				val read = input.read(buffer)
				if (read < 0) break
				out.write(buffer, 0, read)
				if (out.size() > MAX_FILE_BYTES) return null
			}
			return (TextFiles.decode(out.toByteArray()) as? DecodeResult.Success)?.file?.text
			}
		} catch (_: Exception) {
			return null
		}
	}

	private inner class RowAdapter : BaseAdapter() {
		override fun getCount() = rows.size
		override fun getItem(position: Int) = rows[position]
		override fun getItemId(position: Int) = position.toLong()
		override fun getViewTypeCount() = 2
		override fun getItemViewType(position: Int) = if (rows[position] is Row.FileHeader) 0 else 1
		override fun isEnabled(position: Int) = rows[position] is Row.Match

		override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
			val view = convertView as? TextView ?: TextView(context).apply {
				ellipsize = TextUtils.TruncateAt.END
				isSingleLine = true
				gravity = Gravity.CENTER_VERTICAL
			}
			when (val row = rows[position]) {
				is Row.FileHeader -> {
					view.text = "${row.path}  (${row.count})"
					view.setTypeface(Typeface.DEFAULT, Typeface.BOLD)
					view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
					view.setPadding(dp(12), dp(10), dp(12), dp(2))
					view.minHeight = 0
				}
				is Row.Match -> {
					val prefix = "${row.match.line}: "
					val text = SpannableString(prefix + row.match.preview)
					val start = (prefix.length + row.match.previewStart).coerceIn(0, text.length)
					val end = (prefix.length + row.match.previewEnd).coerceIn(start, text.length)
					if (end > start) text.setSpan(BackgroundColorSpan(matchColor), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
					view.text = text
					view.typeface = Typeface.MONOSPACE
					view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
					view.setPadding(dp(20), 0, dp(12), 0)
					view.minHeight = dp(36)
				}
			}
			return view
		}
	}

	private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

	private companion object {
		const val MAX_FILE_BYTES = 2L * 1024 * 1024
		const val MAX_MATCHES = 2000
	}
}
