package editora.app

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.Spanned
import android.text.TextWatcher
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.ScrollView
import editora.core.Edit
import editora.core.Language
import editora.core.LexerKind
import editora.core.Languages
import editora.core.Lexer
import editora.core.Token
import editora.core.UndoHistory
import java.util.concurrent.Executors

/**
 * Plain [EditText] with a line-number gutter, syntax colouring and undo.
 *
 * Input goes through the platform text field unchanged, so IMEs (including
 * Japanese kana-kanji conversion) behave exactly as in any Android app.
 * Colouring never touches the text while the IME is composing.
 *
 * Expected to be the only child of a [ScrollView], which does the scrolling.
 */
class CodeEditText(context: Context) : EditText(context) {
	interface Listener {
		fun onContentEdited()
		fun onCursorMoved()
		fun onShortcut(keyCode: Int, event: KeyEvent): Boolean
	}

	var listener: Listener? = null
	var history = UndoHistory()
		private set
	var colors: SyntaxColors = SyntaxColors.forResources(resources)
	var indentUnit = "    "

	var language: Language = Languages.PLAIN
		set(value) {
			field = value
			tokens = emptyList()
			tokensGeneration = -1
			clearHighlightSpans()
			scheduleHighlight(0)
		}

	private val mainHandler = Handler(Looper.getMainLooper())
	private val lexerThread = Executors.newSingleThreadExecutor()
	private val lexRunnable = Runnable { lex() }
	private val applyRunnable = Runnable { applySpans(force = false) }

	/** Incremented on every text change; stale lexer results are dropped. */
	private var generation = 0
	private var tokens: List<Token> = emptyList()
	private var tokensGeneration = -1
	private var appliedStart = 0
	private var appliedEnd = 0
	private var appliedGeneration = -1

	private var loadingText = false
	private var applyingHistory = false
	private var pendingRemoved = ""

	private var newlineOffsets = IntArray(64)
	private var newlineCount = 0
	private var newlinesDirty = true

	private val gutterTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
		typeface = Typeface.MONOSPACE
		textAlign = Paint.Align.RIGHT
	}
	private val gutterBackgroundPaint = Paint()
	private val gutterDividerPaint = Paint()
	private var gutterWidth = 0
	private var gutterDigits = 0
	private var searchSpan: BackgroundColorSpan? = null

	private val watcher = object : TextWatcher {
		override fun beforeTextChanged(s: CharSequence, start: Int, count: Int, after: Int) {
			if (!loadingText && !applyingHistory) {
				pendingRemoved = s.subSequence(start, start + count).toString()
			}
		}

		override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) {
			generation++
			newlinesDirty = true
			if (loadingText) return
			if (!applyingHistory) {
				history.record(Edit(start, pendingRemoved, s.subSequence(start, start + count).toString()))
				maybeAutoIndent(s, start, before, count)
			}
			listener?.onContentEdited()
		}

		override fun afterTextChanged(s: Editable) {
			updateGutterWidth()
			if (!loadingText) scheduleHighlight(HIGHLIGHT_DELAY_MS)
		}
	}

	init {
		inputType = inputTypeFor(suggestions = false)
		setHorizontallyScrolling(false)
		typeface = Typeface.MONOSPACE
		gravity = Gravity.TOP or Gravity.START
		background = null
		imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN
		// Large files must not go into the saved-instance Bundle (1 MB binder
		// limit); the workspace keeps the text instead.
		isSaveEnabled = false
		addTextChangedListener(watcher)
		setFontSizeSp(14f)
		applyColors()
	}

	fun setFontSizeSp(sizeSp: Float) {
		setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
		gutterTextPaint.textSize = textSize * 0.8f
		gutterDigits = 0
		updateGutterWidth()
	}

	fun applyColors() {
		gutterTextPaint.color = colors.gutterText
		gutterBackgroundPaint.color = colors.gutterBackground
		gutterDividerPaint.color = colors.gutterDivider
		appliedGeneration = -1
		applySpans(force = true)
		invalidate()
	}

	/**
	 * With suggestions off, keyboards do not autocorrect code. IME composition
	 * (Japanese, Chinese, Korean input) works either way.
	 */
	fun setSuggestionsEnabled(enabled: Boolean) {
		val start = selectionStart
		val end = selectionEnd
		inputType = inputTypeFor(enabled)
		typeface = Typeface.MONOSPACE
		setSelection(start.coerceIn(0, length()), end.coerceIn(0, length()))
		inputMethodManager().restartInput(this)
	}

	/** Shows [document] in the editor, sharing its undo history. */
	fun load(document: EditorDocument) {
		mainHandler.removeCallbacks(lexRunnable)
		mainHandler.removeCallbacks(applyRunnable)
		searchSpan = null
		loadingText = true
		try {
			setText(document.text)
		} finally {
			loadingText = false
		}
		history = document.history
		history.breakMerge()
		language = document.language
		val length = length()
		setSelection(document.selectionStart.coerceIn(0, length), document.selectionEnd.coerceIn(0, length))
		updateGutterWidth()
		inputMethodManager().restartInput(this)
	}

	/** Applies an undo/redo [edit] without recording it as a new step. */
	fun applyHistoryEdit(edit: Edit) {
		val editable = text ?: return
		val start = edit.start.coerceIn(0, editable.length)
		val end = (edit.start + edit.removed.length).coerceIn(start, editable.length)
		applyingHistory = true
		try {
			editable.replace(start, end, edit.inserted)
		} finally {
			applyingHistory = false
		}
		setSelection((start + edit.inserted.length).coerceAtMost(length()))
		inputMethodManager().restartInput(this)
	}

	fun insertAtCursor(value: String) {
		val editable = text ?: return
		val start = minOf(selectionStart, selectionEnd).coerceAtLeast(0)
		val end = maxOf(selectionStart, selectionEnd).coerceAtLeast(0)
		editable.replace(start, end, value)
	}

	fun moveCursor(delta: Int) {
		setSelection((selectionEnd + delta).coerceIn(0, length()))
	}

	/** Selects and tints one search match. */
	fun showSearchMatch(range: IntRange) {
		clearSearchMatch()
		val editable = text ?: return
		val end = (range.last + 1).coerceAtMost(editable.length)
		if (range.first >= end) return
		val span = BackgroundColorSpan(colors.searchMatch)
		editable.setSpan(span, range.first, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
		searchSpan = span
		setSelection(range.first, end)
	}

	fun clearSearchMatch() {
		searchSpan?.let { text?.removeSpan(it) }
		searchSpan = null
	}

	/** 1-based line and column of [offset]. */
	fun lineAndColumn(offset: Int): Pair<Int, Int> {
		ensureNewlineIndex()
		val before = newlinesBefore(offset)
		val lineStart = if (before == 0) 0 else newlineOffsets[before - 1] + 1
		return (before + 1) to (offset - lineStart + 1)
	}

	/** Number of logical lines. */
	val logicalLineCount: Int
		get() {
			ensureNewlineIndex()
			return newlineCount + 1
		}

	/** Moves the cursor to the start of 1-based [line], clamped to the document. */
	fun goToLine(line: Int) {
		ensureNewlineIndex()
		val target = line.coerceIn(1, newlineCount + 1)
		val offset = if (target == 1) 0 else newlineOffsets[target - 2] + 1
		requestFocus()
		setSelection(offset.coerceAtMost(length()))
	}

	/** Called by the hosting [ScrollView] when the visible area changes. */
	fun onViewportChanged() {
		invalidate()
		mainHandler.removeCallbacks(applyRunnable)
		mainHandler.postDelayed(applyRunnable, VIEWPORT_DELAY_MS)
	}

	fun release() {
		mainHandler.removeCallbacksAndMessages(null)
		lexerThread.shutdownNow()
	}

	override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
		if (keyCode == KeyEvent.KEYCODE_TAB && !event.isCtrlPressed && !event.isAltPressed) {
			insertAtCursor(indentUnit)
			return true
		}
		return super.onKeyDown(keyCode, event)
	}

	override fun onKeyShortcut(keyCode: Int, event: KeyEvent): Boolean {
		if (listener?.onShortcut(keyCode, event) == true) return true
		return super.onKeyShortcut(keyCode, event)
	}

	override fun onSelectionChanged(selStart: Int, selEnd: Int) {
		super.onSelectionChanged(selStart, selEnd)
		// Called from TextView's constructor too, before our fields exist.
		listener?.onCursorMoved()
	}

	override fun onDraw(canvas: Canvas) {
		val (visibleTop, visibleBottom) = visibleVerticalRange()
		canvas.drawRect(0f, visibleTop.toFloat(), gutterWidth.toFloat(), visibleBottom.toFloat(), gutterBackgroundPaint)
		canvas.drawRect(
			gutterWidth.toFloat() - dp(1),
			visibleTop.toFloat(),
			gutterWidth.toFloat(),
			visibleBottom.toFloat(),
			gutterDividerPaint,
		)
		super.onDraw(canvas)
		drawLineNumbers(canvas, visibleTop, visibleBottom)
	}

	private fun drawLineNumbers(canvas: Canvas, visibleTop: Int, visibleBottom: Int) {
		val layout = layout ?: return
		val content = text ?: return
		ensureNewlineIndex()
		val first = layout.getLineForVertical((visibleTop - totalPaddingTop).coerceAtLeast(0))
		val last = layout.getLineForVertical((visibleBottom - totalPaddingTop).coerceAtLeast(0))
		val x = (gutterWidth - dp(6)).toFloat()
		for (line in first..last) {
			val start = layout.getLineStart(line)
			if (start != 0 && content[start - 1] != '\n') continue // wrapped continuation
			val number = newlinesBefore(start) + 1
			val baseline = (totalPaddingTop + layout.getLineBaseline(line)).toFloat()
			canvas.drawText(number.toString(), x, baseline, gutterTextPaint)
		}
	}

	private fun visibleVerticalRange(): Pair<Int, Int> {
		val scroll = parent as? ScrollView ?: return scrollY to scrollY + height
		val top = scroll.scrollY - this.top
		return top to top + scroll.height
	}

	private fun scheduleHighlight(delayMillis: Long) {
		mainHandler.removeCallbacks(lexRunnable)
		mainHandler.postDelayed(lexRunnable, delayMillis)
	}

	private fun lex() {
		val lang = language
		if (lang.kind == LexerKind.PLAIN) {
			tokens = emptyList()
			tokensGeneration = generation
			clearHighlightSpans()
			return
		}
		val gen = generation
		val snapshot = text?.toString() ?: return
		lexerThread.execute {
			val result = Lexer.tokenize(snapshot, lang)
			mainHandler.post {
				if (gen == generation && lang === language) {
					tokens = result
					tokensGeneration = gen
					applySpans(force = true)
				}
			}
		}
	}

	/** Colours the tokens around the visible area; spans elsewhere are dropped. */
	private fun applySpans(force: Boolean) {
		if (tokensGeneration != generation) return
		if (isComposing()) {
			mainHandler.removeCallbacks(applyRunnable)
			mainHandler.postDelayed(applyRunnable, COMPOSING_RETRY_MS)
			return
		}
		val editable = text ?: return
		val layout = layout ?: return
		val (visibleTop, visibleBottom) = visibleVerticalRange()
		val screen = (visibleBottom - visibleTop).coerceAtLeast(1)
		val firstLine = layout.getLineForVertical((visibleTop - screen * 2).coerceAtLeast(0))
		val lastLine = layout.getLineForVertical((visibleBottom + screen * 2).coerceAtLeast(0))
		val start = layout.getLineStart(firstLine)
		val end = layout.getLineEnd(lastLine)
		if (!force && appliedGeneration == generation && start >= appliedStart && end <= appliedEnd) return

		clearHighlightSpans()
		var index = firstTokenEndingAfter(start)
		val length = editable.length
		while (index < tokens.size) {
			val token = tokens[index++]
			if (token.start >= end) break
			val tokenEnd = token.end.coerceAtMost(length)
			if (token.start >= tokenEnd) continue
			editable.setSpan(
				HighlightSpan(colors.colorOf(token.type)),
				token.start,
				tokenEnd,
				Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
			)
		}
		appliedStart = start
		appliedEnd = end
		appliedGeneration = generation
	}

	private fun firstTokenEndingAfter(offset: Int): Int {
		var low = 0
		var high = tokens.size
		while (low < high) {
			val mid = (low + high) ushr 1
			if (tokens[mid].end <= offset) low = mid + 1 else high = mid
		}
		return low
	}

	private fun clearHighlightSpans() {
		val editable = text ?: return
		for (span in editable.getSpans(0, editable.length, HighlightSpan::class.java)) {
			editable.removeSpan(span)
		}
	}

	private fun isComposing(): Boolean {
		val editable = text ?: return false
		return BaseInputConnection.getComposingSpanStart(editable) != -1
	}

	/** Keeps the current indentation (plus one level after an opening bracket) on Enter. */
	private fun maybeAutoIndent(s: CharSequence, start: Int, before: Int, count: Int) {
		if (count != 1 || before != 0 || s[start] != '\n') return
		var lineStart = start
		while (lineStart > 0 && s[lineStart - 1] != '\n') lineStart--
		var indentEnd = lineStart
		while (indentEnd < start && (s[indentEnd] == ' ' || s[indentEnd] == '\t')) indentEnd++
		var indent = s.subSequence(lineStart, indentEnd).toString()
		if (start > 0 && s[start - 1] in "{[(:") indent += indentUnit
		if (indent.isEmpty()) return
		mainHandler.post {
			val editable = text ?: return@post
			if (start < editable.length && editable[start] == '\n' && selectionEnd == start + 1) {
				editable.insert(start + 1, indent)
			}
		}
	}

	private fun ensureNewlineIndex() {
		if (!newlinesDirty) return
		val content = text ?: return
		var count = 0
		for (i in 0 until content.length) {
			if (content[i] == '\n') {
				if (count == newlineOffsets.size) newlineOffsets = newlineOffsets.copyOf(count * 2)
				newlineOffsets[count++] = i
			}
		}
		newlineCount = count
		newlinesDirty = false
	}

	/** Number of newlines strictly before [offset]. */
	private fun newlinesBefore(offset: Int): Int {
		var low = 0
		var high = newlineCount
		while (low < high) {
			val mid = (low + high) ushr 1
			if (newlineOffsets[mid] < offset) low = mid + 1 else high = mid
		}
		return low
	}

	private fun updateGutterWidth() {
		ensureNewlineIndex()
		val digits = maxOf(3, (newlineCount + 1).toString().length)
		if (digits == gutterDigits) return
		gutterDigits = digits
		gutterWidth = (gutterTextPaint.measureText("9".repeat(digits)) + dp(12)).toInt()
		setPadding(gutterWidth + dp(8), dp(4), dp(8), dp(48))
	}

	private fun inputTypeFor(suggestions: Boolean): Int {
		var type = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
		if (!suggestions) type = type or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
		return type
	}

	private fun inputMethodManager() =
		context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager

	private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

	private class HighlightSpan(color: Int) : ForegroundColorSpan(color)

	private companion object {
		const val HIGHLIGHT_DELAY_MS = 250L
		const val VIEWPORT_DELAY_MS = 80L
		const val COMPOSING_RETRY_MS = 300L
	}
}
