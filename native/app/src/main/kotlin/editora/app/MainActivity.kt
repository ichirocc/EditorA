package editora.app

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.MimeTypeMap
import android.widget.Button
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.widget.Toolbar
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import editora.core.DecodeResult
import editora.core.EncodeResult
import editora.core.Languages
import editora.core.TextEncoding
import editora.core.TextFile
import editora.core.TextFiles
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class MainActivity : Activity(), CodeEditText.Listener {
	private lateinit var prefs: SharedPreferences
	private lateinit var session: SessionStore
	private lateinit var toolbar: Toolbar
	private lateinit var tabsScroll: HorizontalScrollView
	private lateinit var tabsRow: LinearLayout
	private lateinit var searchBar: SearchBar
	private lateinit var scroll: ScrollView
	private lateinit var editor: CodeEditText
	private lateinit var statusView: TextView
	private lateinit var folderPanel: FolderPanel
	private lateinit var scrim: View
	private var panelOpen = false

	private val mainHandler = Handler(Looper.getMainLooper())
	private val io: ExecutorService = Executors.newSingleThreadExecutor()

	private var pendingSaveAsId: String? = null
	private var closeAfterSaveId: String? = null
	private var backCallback: Any? = null

	private val documents get() = Workspace.documents
	private val current: EditorDocument? get() = Workspace.current

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		prefs = getSharedPreferences("settings", MODE_PRIVATE)
		session = SessionStore(File(filesDir, "session.json"))
		pendingSaveAsId = savedInstanceState?.getString(KEY_PENDING_SAVE_AS)
		closeAfterSaveId = savedInstanceState?.getString(KEY_CLOSE_AFTER_SAVE)

		buildUi()
		applySystemBarAppearance()
		Workspace.onDocumentLoaded = ::onDocumentLoaded

		if (!Workspace.restored) {
			Workspace.restored = true
			restoreSession()
		}
		if (documents.isEmpty()) documents += untitledDocument()
		showDocument(Workspace.currentIndex.coerceIn(0, documents.lastIndex))

		if (savedInstanceState == null) handleIntent(intent)
	}

	override fun onNewIntent(intent: Intent) {
		super.onNewIntent(intent)
		setIntent(intent)
		handleIntent(intent)
	}

	override fun onSaveInstanceState(outState: Bundle) {
		super.onSaveInstanceState(outState)
		outState.putString(KEY_PENDING_SAVE_AS, pendingSaveAsId)
		outState.putString(KEY_CLOSE_AFTER_SAVE, closeAfterSaveId)
	}

	override fun onStop() {
		super.onStop()
		syncCurrent()
		try {
			session.save(documents, Workspace.currentIndex)
		} catch (_: Exception) {
			// The session is a convenience; failing to write it must not crash.
		}
	}

	override fun onDestroy() {
		if (Workspace.onDocumentLoaded == ::onDocumentLoaded) Workspace.onDocumentLoaded = null
		editor.release()
		io.shutdown()
		super.onDestroy()
	}

	// region UI

	private fun buildUi() {
		val root = FrameLayout(this).apply {
			setBackgroundColor(themeColor(android.R.attr.colorBackground))
		}
		val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

		toolbar = Toolbar(this).apply {
			setNavigationIcon(R.drawable.ic_menu)
			navigationContentDescription = getString(R.string.nav_files)
			setNavigationOnClickListener { if (panelOpen) closePanel() else openPanel() }
		}
		setActionBar(toolbar)

		tabsRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
		tabsScroll = HorizontalScrollView(this).apply {
			isHorizontalScrollBarEnabled = false
			addView(tabsRow)
		}

		editor = CodeEditText(this).apply {
			setFontSizeSp(prefs.getFloat(KEY_FONT_SIZE, DEFAULT_FONT_SIZE))
			if (prefs.getBoolean(KEY_SUGGESTIONS, false)) setSuggestionsEnabled(true)
			listener = this@MainActivity
		}
		scroll = ScrollView(this).apply {
			isFillViewport = true
			addView(editor, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
			setOnScrollChangeListener { _, _, _, _, _ -> editor.onViewportChanged() }
		}

		searchBar = SearchBar(this, editor).apply {
			onVisibilityChanged = { updateBackCallback() }
			onMatchShown = { ensureCursorVisible() }
		}

		statusView = TextView(this).apply {
			setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
			setPadding(dp(12), dp(2), dp(12), dp(4))
			typeface = Typeface.MONOSPACE
		}

		val match = ViewGroup.LayoutParams.MATCH_PARENT
		val wrap = ViewGroup.LayoutParams.WRAP_CONTENT
		content.addView(toolbar, LinearLayout.LayoutParams(match, wrap))
		content.addView(tabsScroll, LinearLayout.LayoutParams(match, wrap))
		content.addView(searchBar, LinearLayout.LayoutParams(match, wrap))
		content.addView(scroll, LinearLayout.LayoutParams(match, 0, 1f))
		content.addView(quickKeys(), LinearLayout.LayoutParams(match, wrap))
		content.addView(statusView, LinearLayout.LayoutParams(match, wrap))
		root.addView(content, FrameLayout.LayoutParams(match, match))

		scrim = View(this).apply {
			setBackgroundColor(0x66000000)
			visibility = View.GONE
			setOnClickListener { closePanel() }
		}
		root.addView(scrim, FrameLayout.LayoutParams(match, match))

		folderPanel = FolderPanel(this, io, folderHost).apply {
			visibility = View.GONE
			onExpansionChanged = { ids -> prefs.edit().putStringSet(KEY_TREE_EXPANDED, HashSet(ids)).apply() }
		}
		val panelWidth = minOf(dp(320), (resources.displayMetrics.widthPixels * 0.85f).toInt())
		root.addView(folderPanel, FrameLayout.LayoutParams(panelWidth, match, Gravity.START))
		restoreFolder()

		// Android 15+ always draws edge to edge, so pad for the system bars and
		// the keyboard ourselves. On older versions these insets are zero.
		root.setOnApplyWindowInsetsListener { view, insets ->
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
				val bars = insets.getInsets(
					WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime(),
				)
				view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
				mainHandler.post { ensureCursorVisible() }
				WindowInsets.CONSUMED
			} else {
				@Suppress("DEPRECATION")
				view.setPadding(
					insets.systemWindowInsetLeft,
					insets.systemWindowInsetTop,
					insets.systemWindowInsetRight,
					insets.systemWindowInsetBottom,
				)
				mainHandler.post { ensureCursorVisible() }
				@Suppress("DEPRECATION")
				insets.consumeSystemWindowInsets()
			}
		}
		setContentView(root)
	}

	private val folderHost = object : FolderPanel.Host {
		override fun onOpenFile(uri: Uri) {
			closePanel()
			openUri(uri, persist = false)
		}

		override fun onPickFolder() {
			startPicker(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQUEST_OPEN_FOLDER)
		}

		override fun onFileRenamed(oldUri: Uri, newUri: Uri, newName: String) {
			val doc = documents.firstOrNull { it.uri == oldUri } ?: return
			doc.uri = newUri
			doc.name = newName
			if (doc.language == Languages.PLAIN) {
				doc.language = Languages.forFileName(newName)
				if (doc === current) editor.language = doc.language
			}
			renderTabs()
			updateStatus()
		}

		override fun onFileDeleted(uri: Uri) {
			val doc = documents.firstOrNull { it.uri == uri } ?: return
			if (doc.dirty) {
				// Keep the unsaved text; saving will ask for a new location.
				doc.uri = null
				renderTabs()
			} else {
				removeDocument(doc)
			}
		}

		override fun showMessage(message: String) = toast(message)
	}

	/** Re-opens the last folder if its grant is still held. */
	private fun restoreFolder() {
		val uri = prefs.getString(KEY_TREE_URI, null)?.let(Uri::parse) ?: return
		val granted = contentResolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission }
		if (granted) {
			folderPanel.setFolder(uri, prefs.getStringSet(KEY_TREE_EXPANDED, emptySet()).orEmpty())
		} else {
			prefs.edit().remove(KEY_TREE_URI).remove(KEY_TREE_EXPANDED).apply()
		}
	}

	private fun openFolder(uri: Uri) {
		try {
			contentResolver.takePersistableUriPermission(
				uri,
				Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
			)
		} catch (e: SecurityException) {
			toast(getString(R.string.operation_failed, e.message ?: uri.toString()))
			return
		}
		prefs.edit().putString(KEY_TREE_URI, uri.toString()).remove(KEY_TREE_EXPANDED).apply()
		folderPanel.setFolder(uri)
		openPanel()
	}

	private fun openPanel() {
		if (panelOpen) return
		panelOpen = true
		currentFocus?.let { focused ->
			(getSystemService(INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager)
				.hideSoftInputFromWindow(focused.windowToken, 0)
		}
		scrim.visibility = View.VISIBLE
		scrim.alpha = 0f
		scrim.animate().alpha(1f).setDuration(PANEL_ANIMATION_MS).start()
		folderPanel.visibility = View.VISIBLE
		folderPanel.translationX = -folderPanel.layoutParams.width.toFloat()
		folderPanel.animate().translationX(0f).setDuration(PANEL_ANIMATION_MS).start()
		updateBackCallback()
	}

	private fun closePanel() {
		if (!panelOpen) return
		panelOpen = false
		scrim.animate().alpha(0f).setDuration(PANEL_ANIMATION_MS).withEndAction { scrim.visibility = View.GONE }.start()
		folderPanel.animate()
			.translationX(-folderPanel.layoutParams.width.toFloat())
			.setDuration(PANEL_ANIMATION_MS)
			.withEndAction { if (!panelOpen) folderPanel.visibility = View.GONE }
			.start()
		updateBackCallback()
	}

	private fun quickKeys(): View {
		val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
		for (key in QUICK_KEYS) {
			row.addView(Button(this, null, android.R.attr.borderlessButtonStyle).apply {
				text = key
				isAllCaps = false
				typeface = Typeface.MONOSPACE
				minWidth = dp(44)
				minimumWidth = dp(44)
				// Keep focus (and the keyboard) on the editor.
				isFocusable = false
				isFocusableInTouchMode = false
				setOnClickListener {
					when (key) {
						"Tab" -> editor.insertAtCursor(editor.indentUnit)
						"←" -> editor.moveCursor(-1)
						"→" -> editor.moveCursor(1)
						else -> editor.insertAtCursor(key)
					}
				}
			})
		}
		return HorizontalScrollView(this).apply {
			isHorizontalScrollBarEnabled = false
			addView(row)
		}
	}

	private fun renderTabs() {
		tabsRow.removeAllViews()
		val selectedBackground = themeColor(android.R.attr.colorControlHighlight)
		for ((index, doc) in documents.withIndex()) {
			tabsRow.addView(TextView(this).apply {
				text = if (doc.dirty) "● ${doc.name}" else doc.name
				setPadding(dp(14), dp(8), dp(14), dp(8))
				gravity = Gravity.CENTER_VERTICAL
				isSingleLine = true
				isFocusable = false
				if (index == Workspace.currentIndex) {
					setTypeface(typeface, Typeface.BOLD)
					setBackgroundColor(selectedBackground)
				}
				setOnClickListener { switchTo(index) }
				setOnLongClickListener {
					closeDocument(doc)
					true
				}
			})
		}
		toolbar.title = current?.name
		tabsScroll.post {
			tabsRow.getChildAt(Workspace.currentIndex)?.let { tabsScroll.smoothScrollTo((it.left - dp(24)).coerceAtLeast(0), 0) }
		}
	}

	private fun updateStatus() {
		val doc = current ?: return
		val (line, column) = editor.lineAndColumn(editor.selectionStart.coerceAtLeast(0))
		val bom = if (doc.hasBom && !doc.encoding.alwaysHasBom) " BOM" else ""
		val format = "${doc.encoding.displayName}$bom · ${doc.lineEnding.name}"
		statusView.text = getString(R.string.status_format, line, column, doc.language.displayName, format)
	}

	/** Scrolls so the cursor line is visible with a little context. */
	fun ensureCursorVisible() {
		val layout = editor.layout ?: return
		val line = layout.getLineForOffset(editor.selectionEnd.coerceAtLeast(0))
		val top = editor.top + editor.totalPaddingTop + layout.getLineTop(line)
		val bottom = editor.top + editor.totalPaddingTop + layout.getLineBottom(line)
		val margin = editor.lineHeight * 2
		when {
			top - margin < scroll.scrollY -> scroll.smoothScrollTo(0, (top - margin).coerceAtLeast(0))
			bottom + margin > scroll.scrollY + scroll.height -> scroll.smoothScrollTo(0, bottom + margin - scroll.height)
		}
	}

	private fun applySystemBarAppearance() {
		val light = !SyntaxColors.isNight(resources)
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
			val mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
				WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
			window.insetsController?.setSystemBarsAppearance(if (light) mask else 0, mask)
		} else {
			@Suppress("DEPRECATION")
			var flags = window.decorView.systemUiVisibility
			@Suppress("DEPRECATION")
			val lightFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
			flags = if (light) flags or lightFlags else flags and lightFlags.inv()
			@Suppress("DEPRECATION")
			window.decorView.systemUiVisibility = flags
		}
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
			val background = themeColor(android.R.attr.colorBackground)
			@Suppress("DEPRECATION")
			window.statusBarColor = background
			@Suppress("DEPRECATION")
			window.navigationBarColor = background
		}
	}

	// endregion

	// region Documents

	private fun untitledDocument(): EditorDocument {
		val base = getString(R.string.untitled)
		var name = base
		var n = 2
		while (documents.any { it.name == name }) name = "$base ${n++}"
		return EditorDocument(uri = null, name = name, text = "", language = Languages.PLAIN)
	}

	/** Copies the editor's live state into the current document. */
	private fun syncCurrent() {
		val doc = current ?: return
		if (doc.loading) return
		doc.text = editor.text?.toString().orEmpty()
		doc.selectionStart = editor.selectionStart.coerceAtLeast(0)
		doc.selectionEnd = editor.selectionEnd.coerceAtLeast(0)
		doc.scrollY = scroll.scrollY
	}

	private fun showDocument(index: Int) {
		Workspace.currentIndex = index
		val doc = current ?: return
		editor.load(doc)
		editor.isEnabled = !doc.loading
		val y = doc.scrollY
		scroll.post { scroll.scrollTo(0, y) }
		renderTabs()
		updateStatus()
		invalidateOptionsMenu()
	}

	private fun switchTo(index: Int) {
		if (index == Workspace.currentIndex) return
		syncCurrent()
		showDocument(index)
	}

	private fun newDocument() {
		syncCurrent()
		documents += untitledDocument()
		showDocument(documents.lastIndex)
	}

	private fun closeDocument(doc: EditorDocument) {
		if (doc === current) syncCurrent()
		if (!doc.dirty) {
			removeDocument(doc)
			return
		}
		AlertDialog.Builder(this)
			.setTitle(R.string.unsaved_title)
			.setMessage(getString(R.string.unsaved_message, doc.name))
			.setPositiveButton(R.string.action_save) { _, _ ->
				closeAfterSaveId = doc.id
				save(doc)
			}
			.setNegativeButton(R.string.action_discard) { _, _ -> removeDocument(doc) }
			.setNeutralButton(R.string.action_cancel, null)
			.show()
	}

	private fun removeDocument(doc: EditorDocument) {
		val index = documents.indexOf(doc)
		if (index < 0) return
		val wasCurrent = index == Workspace.currentIndex
		documents.removeAt(index)
		doc.uri?.let(::releasePermission)
		if (documents.isEmpty()) {
			documents += untitledDocument()
			showDocument(0)
			return
		}
		val newIndex = when {
			index < Workspace.currentIndex -> Workspace.currentIndex - 1
			else -> Workspace.currentIndex.coerceAtMost(documents.lastIndex)
		}
		if (wasCurrent) {
			showDocument(newIndex)
		} else {
			Workspace.currentIndex = newIndex
			renderTabs()
		}
	}

	private fun restoreSession() {
		val (restored, index) = session.load()
		documents += restored
		Workspace.currentIndex = index.coerceIn(0, (documents.size - 1).coerceAtLeast(0))
		for (doc in restored) if (doc.loading) reload(doc)
	}

	/** Re-reads a restored, unmodified tab from its file. */
	private fun reload(doc: EditorDocument) {
		val uri = doc.uri ?: return
		io.execute {
			val result = readUri(uri)
			mainHandler.post {
				if (result is ReadResult.Ok) {
					doc.applyFile(result.file)
					doc.dirty = false
				}
				doc.loading = false
				doc.loadFailed = result !is ReadResult.Ok
				Workspace.onDocumentLoaded?.invoke(doc)
			}
		}
	}

	private fun onDocumentLoaded(doc: EditorDocument) {
		if (doc.loadFailed) {
			toast(getString(R.string.file_gone, doc.name))
			removeDocument(doc)
			return
		}
		if (doc === current) {
			editor.load(doc)
			editor.isEnabled = true
			val y = doc.scrollY
			scroll.post { scroll.scrollTo(0, y) }
			updateStatus()
		}
	}

	private fun handleIntent(intent: Intent?) {
		if (intent?.action != Intent.ACTION_VIEW && intent?.action != Intent.ACTION_EDIT) return
		val uri = intent.data ?: return
		val persistable = intent.flags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION != 0
		openUri(uri, persist = persistable)
	}

	private fun openUri(uri: Uri, persist: Boolean) {
		val existing = Workspace.indexOfUri(uri)
		if (existing >= 0) {
			switchTo(existing)
			return
		}
		if (persist) takePermission(uri)
		io.execute {
			val name = displayName(uri)
			val result = readUri(uri)
			mainHandler.post {
				if (isDestroyed) return@post
				when (result) {
					is ReadResult.Ok -> {
						syncCurrent()
						val doc = EditorDocument(
							uri = uri,
							name = name,
							text = result.file.text,
							language = Languages.forFileName(name),
						).apply { applyFile(result.file) }
						// Replace the empty tab shown on first launch.
						val placeholder = documents.singleOrNull()?.takeIf { it.uri == null && !it.dirty && it.text.isEmpty() }
						if (placeholder != null) documents.remove(placeholder)
						documents += doc
						showDocument(documents.lastIndex)
					}
					is ReadResult.Failed -> toast(result.message)
				}
			}
		}
	}

	private fun save(doc: EditorDocument) {
		if (doc === current) syncCurrent()
		val uri = doc.uri ?: return saveAs(doc)
		val textAtSave = doc.text
		val bytes = when (val encoded = TextFiles.encode(textAtSave, doc.lineEnding, doc.encoding, doc.hasBom)) {
			is EncodeResult.Success -> encoded.bytes
			is EncodeResult.Unmappable -> {
				closeAfterSaveId = null
				val message = getString(
					R.string.save_unmappable,
					encoded.character,
					encoded.line,
					encoded.column,
					doc.encoding.displayName,
				)
				AlertDialog.Builder(this).setMessage(message).setPositiveButton(android.R.string.ok, null).show()
				return
			}
		}
		io.execute {
			val error = writeUri(uri, bytes)
			mainHandler.post {
				if (isDestroyed) return@post
				if (error != null) {
					closeAfterSaveId = null
					toast(getString(R.string.save_failed, error))
					return@post
				}
				val liveText = if (doc === current) editor.text?.toString() else doc.text
				if (liveText == textAtSave) doc.dirty = false
				toast(getString(R.string.saved, doc.name))
				if (closeAfterSaveId == doc.id) {
					closeAfterSaveId = null
					removeDocument(doc)
				} else {
					renderTabs()
				}
			}
		}
	}

	private fun saveAs(doc: EditorDocument) {
		pendingSaveAsId = doc.id
		val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
			.addCategory(Intent.CATEGORY_OPENABLE)
			.setType(mimeTypeFor(doc.name))
			.putExtra(Intent.EXTRA_TITLE, doc.name)
		startPicker(intent, REQUEST_SAVE_AS)
	}

	private fun completeSaveAs(uri: Uri) {
		val doc = Workspace.find(pendingSaveAsId) ?: return
		pendingSaveAsId = null
		takePermission(uri)
		doc.uri = uri
		io.execute {
			val name = displayName(uri)
			mainHandler.post {
				if (isDestroyed) return@post
				doc.name = name
				if (doc.language == Languages.PLAIN) {
					doc.language = Languages.forFileName(name)
					if (doc === current) editor.language = doc.language
				}
				renderTabs()
				updateStatus()
				save(doc)
			}
		}
	}

	private fun openPicker() {
		val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
			.addCategory(Intent.CATEGORY_OPENABLE)
			.setType("*/*")
		startPicker(intent, REQUEST_OPEN)
	}

	private fun startPicker(intent: Intent, requestCode: Int) {
		try {
			startActivityForResult(intent, requestCode)
		} catch (e: ActivityNotFoundException) {
			toast(e.message ?: e.javaClass.simpleName)
		}
	}

	override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
		super.onActivityResult(requestCode, resultCode, data)
		val uri = data?.data
		if (resultCode != RESULT_OK || uri == null) {
			if (requestCode == REQUEST_SAVE_AS) {
				pendingSaveAsId = null
				closeAfterSaveId = null
			}
			return
		}
		when (requestCode) {
			REQUEST_OPEN -> openUri(uri, persist = true)
			REQUEST_SAVE_AS -> completeSaveAs(uri)
			REQUEST_OPEN_FOLDER -> openFolder(uri)
		}
	}

	// endregion

	// region File access (called on the io thread)

	private sealed class ReadResult {
		class Ok(val file: TextFile) : ReadResult()
		class Failed(val message: String) : ReadResult()
	}

	private fun EditorDocument.applyFile(file: TextFile) {
		text = file.text
		lineEnding = file.lineEnding
		hasBom = file.hasBom
		encoding = file.encoding
	}

	private fun readUri(uri: Uri, forced: TextEncoding? = null): ReadResult {
		val bytes = try {
			contentResolver.openInputStream(uri)?.use { input ->
				val out = ByteArrayOutputStream()
				val buffer = ByteArray(64 * 1024)
				while (true) {
					val read = input.read(buffer)
					if (read < 0) break
					out.write(buffer, 0, read)
					if (out.size() > MAX_FILE_BYTES) {
						return ReadResult.Failed(getString(R.string.file_too_large, MAX_FILE_BYTES / (1024 * 1024)))
					}
				}
				out.toByteArray()
			} ?: return ReadResult.Failed(getString(R.string.open_failed, uri.lastPathSegment ?: uri.toString()))
		} catch (e: Exception) {
			return ReadResult.Failed(getString(R.string.open_failed, e.message ?: e.javaClass.simpleName))
		}
		return when (val decoded = TextFiles.decode(bytes, forced)) {
			is DecodeResult.Success -> ReadResult.Ok(decoded.file)
			DecodeResult.Binary -> ReadResult.Failed(getString(R.string.file_binary))
			DecodeResult.Unsupported -> ReadResult.Failed(
				if (forced != null) getString(R.string.encoding_mismatch, forced.displayName) else getString(R.string.file_unsupported_encoding),
			)
		}
	}

	/** Returns null on success, or an error message. */
	private fun writeUri(uri: Uri, bytes: ByteArray): String? {
		return try {
			val stream = try {
				contentResolver.openOutputStream(uri, "wt")
			} catch (_: FileNotFoundException) {
				contentResolver.openOutputStream(uri, "w")
			} catch (_: IllegalArgumentException) {
				contentResolver.openOutputStream(uri, "w")
			}
			(stream ?: return uri.toString()).use { it.write(bytes) }
			null
		} catch (e: Exception) {
			e.message ?: e.javaClass.simpleName
		}
	}

	private fun displayName(uri: Uri): String {
		try {
			contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
				if (cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0)
			}
		} catch (_: Exception) {
			// Fall through to the URI's last segment.
		}
		return uri.lastPathSegment?.substringAfterLast('/') ?: getString(R.string.untitled)
	}

	private fun takePermission(uri: Uri) {
		val readWrite = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
		try {
			contentResolver.takePersistableUriPermission(uri, readWrite)
		} catch (_: SecurityException) {
			try {
				contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
			} catch (_: SecurityException) {
				// Only a temporary grant; the tab works until the app restarts.
			}
		}
	}

	private fun releasePermission(uri: Uri) {
		if (documents.any { it.uri == uri }) return
		try {
			contentResolver.releasePersistableUriPermission(
				uri,
				Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
			)
		} catch (_: SecurityException) {
			// Not persisted, or only read was persisted.
		}
	}

	// endregion

	// region Menu and shortcuts

	override fun onCreateOptionsMenu(menu: Menu): Boolean {
		menu.add(0, ID_UNDO, 0, R.string.menu_undo).setIcon(R.drawable.ic_undo)
			.setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
		menu.add(0, ID_REDO, 1, R.string.menu_redo).setIcon(R.drawable.ic_redo)
			.setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
		menu.add(0, ID_SAVE, 2, R.string.menu_save).setIcon(R.drawable.ic_save)
			.setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
		menu.add(0, ID_FIND, 3, R.string.menu_find).setIcon(R.drawable.ic_search)
			.setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
		menu.add(0, ID_OPEN, 4, R.string.menu_open).setIcon(R.drawable.ic_open)
			.setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
		menu.add(0, ID_NEW, 5, R.string.menu_new)
		menu.add(0, ID_OPEN_FOLDER, 5, R.string.menu_open_folder)
		menu.add(0, ID_SAVE_AS, 6, R.string.menu_save_as)
		menu.add(0, ID_CLOSE, 7, R.string.menu_close_tab)
		val languages = menu.addSubMenu(0, ID_LANGUAGE, 8, R.string.menu_language)
		for ((index, language) in Languages.ALL.withIndex()) {
			languages.add(GROUP_LANGUAGE, ID_LANGUAGE_BASE + index, index, language.displayName)
		}
		languages.setGroupCheckable(GROUP_LANGUAGE, true, true)
		val encodings = menu.addSubMenu(0, ID_ENCODING, 8, R.string.menu_encoding)
		for ((index, encoding) in TextEncoding.entries.withIndex()) {
			if (encoding.isAvailable) encodings.add(GROUP_ENCODING, ID_ENCODING_BASE + index, index, encoding.displayName)
		}
		encodings.setGroupCheckable(GROUP_ENCODING, true, true)
		menu.add(0, ID_FONT_LARGER, 9, R.string.menu_font_larger)
		menu.add(0, ID_FONT_SMALLER, 10, R.string.menu_font_smaller)
		menu.add(0, ID_SUGGESTIONS, 11, R.string.menu_suggestions).isCheckable = true
		return true
	}

	override fun onPrepareOptionsMenu(menu: Menu): Boolean {
		menu.findItem(ID_ENCODING_BASE + (current?.encoding ?: TextEncoding.UTF_8).ordinal)?.isChecked = true
		val languageIndex = Languages.ALL.indexOf(current?.language ?: Languages.PLAIN)
		menu.findItem(ID_LANGUAGE_BASE + languageIndex)?.isChecked = true
		menu.findItem(ID_SUGGESTIONS)?.isChecked = prefs.getBoolean(KEY_SUGGESTIONS, false)
		return true
	}

	override fun onOptionsItemSelected(item: MenuItem): Boolean {
		val id = item.itemId
		if (id in ID_ENCODING_BASE until ID_ENCODING_BASE + TextEncoding.entries.size) {
			chooseEncoding(TextEncoding.entries[id - ID_ENCODING_BASE])
			return true
		}
		if (id in ID_LANGUAGE_BASE until ID_LANGUAGE_BASE + Languages.ALL.size) {
			setLanguage(Languages.ALL[id - ID_LANGUAGE_BASE])
			return true
		}
		when (id) {
			ID_UNDO -> undo()
			ID_REDO -> redo()
			ID_SAVE -> current?.let(::save)
			ID_FIND -> toggleSearch()
			ID_OPEN -> openPicker()
			ID_NEW -> newDocument()
			ID_OPEN_FOLDER -> folderHost.onPickFolder()
			ID_SAVE_AS -> current?.let { syncCurrent(); saveAs(it) }
			ID_CLOSE -> current?.let(::closeDocument)
			ID_FONT_LARGER -> changeFontSize(1f)
			ID_FONT_SMALLER -> changeFontSize(-1f)
			ID_SUGGESTIONS -> {
				val enabled = !prefs.getBoolean(KEY_SUGGESTIONS, false)
				prefs.edit().putBoolean(KEY_SUGGESTIONS, enabled).apply()
				editor.setSuggestionsEnabled(enabled)
			}
			else -> return super.onOptionsItemSelected(item)
		}
		return true
	}

	override fun onShortcut(keyCode: Int, event: KeyEvent): Boolean {
		if (!event.isCtrlPressed) return false
		when (keyCode) {
			KeyEvent.KEYCODE_S -> current?.let { if (event.isShiftPressed) { syncCurrent(); saveAs(it) } else save(it) }
			KeyEvent.KEYCODE_Z -> if (event.isShiftPressed) redo() else undo()
			KeyEvent.KEYCODE_Y -> redo()
			KeyEvent.KEYCODE_F -> toggleSearch()
			KeyEvent.KEYCODE_O -> openPicker()
			KeyEvent.KEYCODE_N -> newDocument()
			KeyEvent.KEYCODE_W -> current?.let(::closeDocument)
			else -> return false
		}
		return true
	}

	override fun onContentEdited() {
		val doc = current ?: return
		if (!doc.dirty) {
			doc.dirty = true
			renderTabs()
		}
	}

	override fun onCursorMoved() {
		if (::statusView.isInitialized) updateStatus()
	}

	private fun undo() {
		editor.history.undo()?.let(editor::applyHistoryEdit) ?: return
		ensureCursorVisible()
	}

	private fun redo() {
		editor.history.redo()?.let(editor::applyHistoryEdit) ?: return
		ensureCursorVisible()
	}

	private fun toggleSearch() {
		if (searchBar.isShowing) searchBar.hide() else searchBar.show()
	}

	private fun setLanguage(language: editora.core.Language) {
		val doc = current ?: return
		doc.language = language
		editor.language = language
		updateStatus()
		invalidateOptionsMenu()
	}

	/**
	 * Either re-reads the file in [encoding] (when detection guessed wrong) or
	 * keeps the text and converts it to [encoding] on the next save.
	 */
	private fun chooseEncoding(encoding: TextEncoding) {
		val doc = current ?: return
		if (encoding == doc.encoding) return
		if (doc.uri == null) {
			convertEncoding(doc, encoding)
			return
		}
		val options = arrayOf(
			getString(R.string.encoding_reopen, encoding.displayName),
			getString(R.string.encoding_convert, encoding.displayName),
		)
		AlertDialog.Builder(this)
			.setTitle(R.string.menu_encoding)
			.setItems(options) { _, which ->
				if (which == 0) confirmReopen(doc, encoding) else convertEncoding(doc, encoding)
			}
			.show()
	}

	private fun confirmReopen(doc: EditorDocument, encoding: TextEncoding) {
		if (!doc.dirty) {
			reopen(doc, encoding)
			return
		}
		AlertDialog.Builder(this)
			.setMessage(R.string.encoding_reopen_discard)
			.setPositiveButton(R.string.action_discard) { _, _ -> reopen(doc, encoding) }
			.setNegativeButton(R.string.action_cancel, null)
			.show()
	}

	private fun reopen(doc: EditorDocument, encoding: TextEncoding) {
		val uri = doc.uri ?: return
		io.execute {
			val result = readUri(uri, encoding)
			mainHandler.post {
				if (isDestroyed) return@post
				when (result) {
					is ReadResult.Ok -> {
						doc.applyFile(result.file)
						doc.dirty = false
						doc.history.clear()
						doc.selectionStart = 0
						doc.selectionEnd = 0
						if (doc === current) showDocument(Workspace.currentIndex) else renderTabs()
					}
					is ReadResult.Failed -> toast(result.message)
				}
			}
		}
	}

	private fun convertEncoding(doc: EditorDocument, encoding: TextEncoding) {
		doc.encoding = encoding
		doc.hasBom = encoding.alwaysHasBom
		if (!doc.dirty) {
			doc.dirty = true
			renderTabs()
		}
		updateStatus()
		invalidateOptionsMenu()
	}

	private fun changeFontSize(delta: Float) {
		val size = (prefs.getFloat(KEY_FONT_SIZE, DEFAULT_FONT_SIZE) + delta).coerceIn(8f, 32f)
		prefs.edit().putFloat(KEY_FONT_SIZE, size).apply()
		editor.setFontSizeSp(size)
	}

	// endregion

	// region Back navigation

	/** Closes the topmost transient UI. Returns false when there was none. */
	private fun handleBack(): Boolean {
		when {
			panelOpen -> closePanel()
			searchBar.isShowing -> searchBar.hide()
			else -> return false
		}
		return true
	}

	private fun updateBackCallback() {
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
		val dispatcher = onBackInvokedDispatcher
		val needed = panelOpen || searchBar.isShowing
		if (needed && backCallback == null) {
			val callback = OnBackInvokedCallback { handleBack() }
			dispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback)
			backCallback = callback
		} else if (!needed && backCallback != null) {
			dispatcher.unregisterOnBackInvokedCallback(backCallback as OnBackInvokedCallback)
			backCallback = null
		}
	}

	@Deprecated("Used below Android 13 only")
	override fun onBackPressed() {
		if (handleBack()) return
		@Suppress("DEPRECATION")
		super.onBackPressed()
	}

	// endregion

	private fun mimeTypeFor(name: String): String {
		val extension = name.substringAfterLast('.', missingDelimiterValue = "").lowercase()
		return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "application/octet-stream"
	}

	private fun themeColor(attr: Int): Int {
		val value = TypedValue()
		theme.resolveAttribute(attr, value, true)
		return if (value.resourceId != 0) getColor(value.resourceId) else value.data
	}

	private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

	private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

	private companion object {
		const val MAX_FILE_BYTES = 2 * 1024 * 1024
		const val DEFAULT_FONT_SIZE = 14f
		const val KEY_FONT_SIZE = "fontSize"
		const val KEY_SUGGESTIONS = "keyboardSuggestions"
		const val KEY_PENDING_SAVE_AS = "pendingSaveAs"
		const val KEY_CLOSE_AFTER_SAVE = "closeAfterSave"
		const val KEY_TREE_URI = "treeUri"
		const val KEY_TREE_EXPANDED = "treeExpanded"
		const val PANEL_ANIMATION_MS = 180L

		const val REQUEST_OPEN = 1
		const val REQUEST_SAVE_AS = 2
		const val REQUEST_OPEN_FOLDER = 3

		const val ID_UNDO = 1
		const val ID_REDO = 2
		const val ID_SAVE = 3
		const val ID_FIND = 4
		const val ID_OPEN = 5
		const val ID_NEW = 6
		const val ID_SAVE_AS = 7
		const val ID_CLOSE = 8
		const val ID_LANGUAGE = 9
		const val ID_FONT_LARGER = 10
		const val ID_FONT_SMALLER = 11
		const val ID_SUGGESTIONS = 12
		const val ID_OPEN_FOLDER = 13
		const val ID_ENCODING = 14
		const val GROUP_ENCODING = 101
		const val ID_ENCODING_BASE = 2000
		const val GROUP_LANGUAGE = 100
		const val ID_LANGUAGE_BASE = 1000

		val QUICK_KEYS = listOf("Tab", "←", "→", "{", "}", "(", ")", "[", "]", "<", ">", ";", "=", "\"", "'", "/", ":", "#")
	}
}
