/**
 * GET through the native HTTP plugin. Unlike `fetch` in the WebView it is
 * not subject to CORS, so it can follow GitHub's job-log redirect to another
 * host (the redirect drops the Authorization header).
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<string>}
 */
export function nativeGetText(url, headers) {
	return new Promise((resolve, reject) => {
		const http = window.cordova?.plugin?.http;
		if (!http) {
			reject(new Error("Native HTTP is unavailable."));
			return;
		}
		http.sendRequest(
			url,
			{ method: "GET", headers, responseType: "text" },
			(response) => resolve(response.data || ""),
			(error) =>
				reject(new Error(error?.error || `HTTP ${error?.status ?? "error"}`)),
		);
	});
}
