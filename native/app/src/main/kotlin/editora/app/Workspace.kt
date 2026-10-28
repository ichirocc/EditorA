package editora.app

import android.net.Uri
import editora.core.Language
import editora.core.LineEnding
import editora.core.Languages
import editora.core.UndoHistory
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** One open tab. The active tab's live text is in the editor view, not [text]. */
class EditorDocument(
	var uri: Uri?,
	var name: String,
	var text: String,
	var language: Language = Languages.forFileName(name),
	var lineEnding: LineEnding = LineEnding.LF,
	var hasBom: Boolean = false,
	var dirty: Boolean = false,
	val id: String = UUID.randomUUID().toString(),
) {
	val history = UndoHistory()
	var selectionStart = 0
	var selectionEnd = 0
	var scrollY = 0

	/** True until a restored tab's content has been re-read from its file. */
	var loading = false

	/** Set when that re-read failed (file deleted or permission lost). */
	var loadFailed = false
}

/**
 * Open tabs, kept for the lifetime of the process so they survive activity
 * recreation (theme change, multi-window) with undo history intact.
 * [SessionStore] persists them across process death.
 */
object Workspace {
	val documents = mutableListOf<EditorDocument>()
	var currentIndex = 0
	var restored = false

	/**
	 * Called on the main thread when a restored tab finishes loading. Held
	 * here rather than by the activity that started the load, because that
	 * activity may have been recreated in the meantime.
	 */
	var onDocumentLoaded: ((EditorDocument) -> Unit)? = null

	val current: EditorDocument? get() = documents.getOrNull(currentIndex)

	fun find(id: String?): EditorDocument? = documents.firstOrNull { it.id == id }

	fun indexOfUri(uri: Uri): Int = documents.indexOfFirst { it.uri == uri }
}

/**
 * Saves the open tabs to app-private storage. Unsaved text is stored so
 * nothing is lost if Android kills the app in the background; saved files
 * are only referenced by URI and re-read on restore.
 */
class SessionStore(private val file: File) {
	fun save(documents: List<EditorDocument>, currentIndex: Int) {
		val tabs = JSONArray()
		for (doc in documents) {
			val tab = JSONObject()
				.put("id", doc.id)
				.put("name", doc.name)
				.put("language", doc.language.id)
				.put("lineEnding", doc.lineEnding.name)
				.put("bom", doc.hasBom)
				.put("dirty", doc.dirty)
				.put("selectionStart", doc.selectionStart)
				.put("selectionEnd", doc.selectionEnd)
				.put("scrollY", doc.scrollY)
			doc.uri?.let { tab.put("uri", it.toString()) }
			if (doc.dirty || doc.uri == null) tab.put("text", doc.text)
			tabs.put(tab)
		}
		val json = JSONObject().put("current", currentIndex).put("tabs", tabs)
		val tmp = File(file.parentFile, file.name + ".tmp")
		tmp.writeText(json.toString())
		if (!tmp.renameTo(file)) {
			file.writeText(json.toString())
			tmp.delete()
		}
	}

	/** Returns the restored tabs and selected index; tabs needing a re-read have [EditorDocument.loading] set. */
	fun load(): Pair<List<EditorDocument>, Int> {
		if (!file.exists()) return emptyList<EditorDocument>() to 0
		return try {
			val json = JSONObject(file.readText())
			val tabs = json.getJSONArray("tabs")
			val documents = (0 until tabs.length()).map { i ->
				val tab = tabs.getJSONObject(i)
				val uri = tab.optString("uri").takeIf { it.isNotEmpty() }?.let(Uri::parse)
				val hasText = tab.has("text")
				EditorDocument(
					uri = uri,
					name = tab.getString("name"),
					text = tab.optString("text"),
					language = Languages.byId(tab.optString("language")),
					lineEnding = runCatching { LineEnding.valueOf(tab.optString("lineEnding")) }.getOrDefault(LineEnding.LF),
					hasBom = tab.optBoolean("bom"),
					dirty = tab.optBoolean("dirty"),
					id = tab.getString("id"),
				).apply {
					selectionStart = tab.optInt("selectionStart")
					selectionEnd = tab.optInt("selectionEnd")
					scrollY = tab.optInt("scrollY")
					loading = !hasText && uri != null
				}
			}
			documents to json.optInt("current")
		} catch (_: Exception) {
			emptyList<EditorDocument>() to 0
		}
	}
}
