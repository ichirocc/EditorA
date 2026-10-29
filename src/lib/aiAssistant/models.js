import { createModelAdapter } from "../../../ai-assistant/core/providers.js";
import { nativeGetText, nativePostText } from "./nativeHttp";

/** How the assistant's system prompt describes the editor. */
export const EDITOR_HOST =
	"EditorA, a code editor running on the user's Android phone";

/**
 * The shared core's model adapter, set up for the editor's WebView: the
 * Anthropic SDK may call the API from the WebView, and providers without
 * CORS headers are reached through the native HTTP plugin.
 * @param {Parameters<typeof createModelAdapter>[0]} options
 */
export function createEditorModelAdapter(options) {
	return createModelAdapter({
		...options,
		browser: true,
		nativeGet: nativeGetText,
		nativePost: nativePostText,
	});
}
