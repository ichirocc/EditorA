package editora.app

import android.content.Context
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import editora.core.SearchOptions
import editora.core.TextSearch

/** Find/replace panel operating on a [CodeEditText]. */
class SearchBar(context: Context, private val editor: CodeEditText) : LinearLayout(context) {
	private val findInput = EditText(context)
	private val replaceInput = EditText(context)
	private val matchCase = CheckBox(context)
	private val wholeWord = CheckBox(context)
	private val regex = CheckBox(context)
	private val status = TextView(context)

	init {
		orientation = VERTICAL
		val pad = dp(8)
		setPadding(pad, dp(4), pad, dp(4))

		findInput.hint = context.getString(R.string.find_hint)
		findInput.isSingleLine = true
		findInput.inputType = InputType.TYPE_CLASS_TEXT
		findInput.imeOptions = EditorInfo.IME_ACTION_SEARCH
		findInput.setOnEditorActionListener { _, actionId, event ->
			val isEnter = event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
			if (actionId == EditorInfo.IME_ACTION_SEARCH || isEnter) {
				findNext()
				true
			} else {
				false
			}
		}
		findInput.addTextChangedListener(object : TextWatcher {
			override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
			override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
			override fun afterTextChanged(s: Editable?) = updateCount()
		})

		replaceInput.hint = context.getString(R.string.replace_hint)
		replaceInput.isSingleLine = true
		replaceInput.inputType = InputType.TYPE_CLASS_TEXT

		matchCase.text = context.getString(R.string.match_case)
		wholeWord.text = context.getString(R.string.whole_word)
		regex.text = context.getString(R.string.regex)
		for (box in listOf(matchCase, wholeWord, regex)) {
			box.setOnCheckedChangeListener { _, _ -> updateCount() }
		}

		addView(row(findInput, button("▲") { findPrevious() }, button("▼") { findNext() }, button("✕") { hide() }))
		addView(row(replaceInput, button(context.getString(R.string.replace)) { replaceOne() }, button(context.getString(R.string.replace_all)) { replaceAll() }))
		addView(row(matchCase, wholeWord, regex, status))
		visibility = GONE
	}

	val isShowing: Boolean get() = visibility == VISIBLE

	var onVisibilityChanged: ((Boolean) -> Unit)? = null

	/** Lets the host scroll the selected match into view. */
	var onMatchShown: (() -> Unit)? = null

	fun show() {
		visibility = VISIBLE
		val selected = editor.text?.subSequence(
			minOf(editor.selectionStart, editor.selectionEnd).coerceAtLeast(0),
			maxOf(editor.selectionStart, editor.selectionEnd).coerceAtLeast(0),
		)?.toString().orEmpty()
		if (selected.isNotEmpty() && !selected.contains('\n')) findInput.setText(selected)
		findInput.requestFocus()
		findInput.selectAll()
		updateCount()
		onVisibilityChanged?.invoke(true)
	}

	fun hide() {
		visibility = GONE
		editor.clearSearchMatch()
		editor.requestFocus()
		onVisibilityChanged?.invoke(false)
	}

	private fun options() = SearchOptions(matchCase.isChecked, wholeWord.isChecked, regex.isChecked)

	private fun pattern(): Regex? {
		val query = findInput.text.toString()
		val pattern = TextSearch.pattern(query, options())
		if (pattern == null && query.isNotEmpty()) status.text = context.getString(R.string.invalid_regex)
		return pattern
	}

	private fun findNext() {
		val pattern = pattern() ?: return
		val text = editor.text ?: return
		val from = maxOf(editor.selectionStart, editor.selectionEnd)
		show(TextSearch.findNext(text, pattern, from))
	}

	private fun findPrevious() {
		val pattern = pattern() ?: return
		val text = editor.text ?: return
		val before = minOf(editor.selectionStart, editor.selectionEnd)
		show(TextSearch.findPrevious(text, pattern, before))
	}

	private fun show(range: IntRange?) {
		if (range == null) {
			status.text = context.getString(R.string.no_match)
			return
		}
		editor.showSearchMatch(range)
		onMatchShown?.invoke()
	}

	private fun replaceOne() {
		val pattern = pattern() ?: return
		val text = editor.text ?: return
		val start = minOf(editor.selectionStart, editor.selectionEnd)
		val end = maxOf(editor.selectionStart, editor.selectionEnd)
		val match = pattern.find(text, start)
		if (match != null && match.range.first == start && match.range.last + 1 == end) {
			editor.clearSearchMatch()
			val replacement = TextSearch.replacementFor(match, replaceInput.text.toString(), options())
			text.replace(start, end, replacement)
			// Continue after the replacement so it is never matched again.
			editor.setSelection(start + replacement.length)
		}
		findNext()
		updateCount()
	}

	private fun replaceAll() {
		val pattern = pattern() ?: return
		val text = editor.text ?: return
		val (result, count) = TextSearch.replaceAll(text, pattern, replaceInput.text.toString(), options())
		if (count > 0) {
			editor.clearSearchMatch()
			editor.history.breakMerge()
			text.replace(0, text.length, result)
			editor.history.breakMerge()
		}
		status.text = context.getString(R.string.replaced_count, count)
	}

	private fun updateCount() {
		val query = findInput.text.toString()
		if (query.isEmpty()) {
			status.text = ""
			return
		}
		val pattern = pattern() ?: return
		val text = editor.text ?: return
		status.text = context.getString(R.string.find_count, TextSearch.countMatches(text, pattern))
	}

	private fun row(vararg views: View): LinearLayout = LinearLayout(context).apply {
		orientation = HORIZONTAL
		gravity = Gravity.CENTER_VERTICAL
		for ((index, view) in views.withIndex()) {
			val weight = if (index == 0 && view is EditText) 1f else 0f
			val width = if (weight > 0f) 0 else LayoutParams.WRAP_CONTENT
			addView(view, LayoutParams(width, LayoutParams.WRAP_CONTENT, weight))
		}
	}

	private fun button(label: String, onClick: () -> Unit) =
		Button(context, null, android.R.attr.borderlessButtonStyle).apply {
			text = label
			isAllCaps = false
			minWidth = dp(40)
			minimumWidth = dp(40)
			setOnClickListener { onClick() }
		}

	private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
}
