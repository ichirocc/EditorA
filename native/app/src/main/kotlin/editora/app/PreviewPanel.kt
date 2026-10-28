package editora.app

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.TextView
import editora.core.Markdown
import java.io.ByteArrayInputStream

/**
 * Full-screen preview of Markdown or HTML.
 *
 * The WebView is sandboxed: no network (the app has no INTERNET permission,
 * network loads are blocked and every sub-resource request is answered
 * empty), no file or content access, no storage, and JavaScript off unless
 * the user turns it on for HTML. Links open in the user's browser.
 */
class PreviewPanel(context: Context, private val onClose: () -> Unit) : LinearLayout(context) {
	private val title = TextView(context)
	private val javaScript = CheckBox(context)
	private var webView: WebView? = null
	private var html = ""
	private var isMarkdown = true

	init {
		orientation = VERTICAL
		setBackgroundColor(themeColor(android.R.attr.colorBackground))
		isClickable = true // keep touches from reaching the editor underneath

		title.apply {
			setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
			setTypeface(typeface, Typeface.BOLD)
			isSingleLine = true
			ellipsize = TextUtils.TruncateAt.MIDDLE
			setPadding(dp(16), dp(12), dp(8), dp(12))
		}
		javaScript.text = context.getString(R.string.preview_javascript)
		javaScript.setOnCheckedChangeListener { _, _ -> render() }
		val close = Button(context, null, android.R.attr.borderlessButtonStyle).apply {
			text = "✕"
			contentDescription = context.getString(R.string.close)
			minWidth = dp(48)
			minimumWidth = dp(48)
			setOnClickListener { onClose() }
		}
		val header = LinearLayout(context).apply {
			orientation = HORIZONTAL
			gravity = Gravity.CENTER_VERTICAL
			addView(title, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
			addView(javaScript)
			addView(close)
		}
		addView(header, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
		visibility = GONE
	}

	val isShowing: Boolean get() = visibility == VISIBLE

	fun show(name: String, source: String, markdown: Boolean) {
		title.text = name
		isMarkdown = markdown
		html = if (markdown) markdownPage(Markdown.toHtml(source)) else source
		javaScript.visibility = if (markdown) GONE else VISIBLE
		if (markdown) javaScript.isChecked = false
		if (webView == null) {
			val view = createWebView()
			webView = view
			addView(view, LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))
		}
		render()
		visibility = VISIBLE
	}

	/** Hides the preview and frees the WebView. */
	fun hide() {
		visibility = GONE
		webView?.let {
			removeView(it)
			it.destroy()
		}
		webView = null
		html = ""
	}

	private fun render() {
		val view = webView ?: return
		view.settings.javaScriptEnabled = !isMarkdown && javaScript.isChecked
		view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
	}

	private fun createWebView() = WebView(context).apply {
		settings.apply {
			javaScriptEnabled = false
			javaScriptCanOpenWindowsAutomatically = false
			setSupportMultipleWindows(false)
			allowFileAccess = false
			allowContentAccess = false
			blockNetworkLoads = true
			domStorageEnabled = false
			setGeolocationEnabled(false)
			builtInZoomControls = true
			displayZoomControls = false
		}
		webViewClient = object : WebViewClient() {
			override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
				val url = request.url
				if (url.scheme in setOf("http", "https", "mailto")) {
					try {
						context.startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
					} catch (_: ActivityNotFoundException) {
						// No app can open it; stay on the preview.
					}
				}
				return true
			}

			override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
				// Only inline data: resources may load; everything else gets an empty answer.
				if (request.url.scheme == "data") return null
				return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
			}
		}
	}

	private fun markdownPage(body: String): String {
		val dark = SyntaxColors.isNight(resources)
		val text = if (dark) "#E6E6E6" else "#1F2328"
		val muted = if (dark) "#9DA5AE" else "#59636E"
		val border = if (dark) "#3D444D" else "#D1D9E0"
		val code = if (dark) "#2D333B" else "#F0F2F4"
		val link = if (dark) "#6CB6FF" else "#0969DA"
		val background = if (dark) "#121212" else "#FFFFFF"
		return """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
body{font-family:sans-serif;line-height:1.6;color:$text;background:$background;margin:0;padding:16px;word-wrap:break-word}
h1,h2{border-bottom:1px solid $border;padding-bottom:.3em}
a{color:$link}
code{font-family:monospace;background:$code;padding:.15em .35em;border-radius:4px;font-size:90%}
pre{background:$code;padding:12px;border-radius:6px;overflow-x:auto}
pre code{padding:0;background:none}
blockquote{margin:0;padding:0 1em;color:$muted;border-left:4px solid $border}
table{border-collapse:collapse;display:block;overflow-x:auto}
th,td{border:1px solid $border;padding:6px 12px}
img{max-width:100%}
hr{border:0;border-top:1px solid $border}
</style></head><body>
$body
</body></html>"""
	}

	private fun themeColor(attr: Int): Int {
		val value = TypedValue()
		context.theme.resolveAttribute(attr, value, true)
		return if (value.resourceId != 0) context.getColor(value.resourceId) else value.data
	}

	private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
}
