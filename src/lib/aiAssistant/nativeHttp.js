/**
 * Requests through the native HTTP plugin. Unlike `fetch` in the WebView
 * they are not subject to CORS, so they reach APIs that send no CORS
 * headers, and can follow GitHub's job-log redirect to another host (the
 * redirect drops the Authorization header).
 */

/**
 * Error for a failed native request, with the provider's message if the
 * body is JSON.
 * @param {{status?:number, error?:string}} failure
 * @returns {Error & {status:number}}
 */
function nativeError(failure) {
	const status = failure?.status ?? 0;
	let message = failure?.error || "Request failed";
	try {
		const data = JSON.parse(message);
		message = data?.error?.message || data?.message || message;
	} catch {
		// Not JSON: keep the text.
	}
	const error = new Error(
		`${status > 0 ? `${status}: ` : ""}${String(message).slice(0, 500)}`,
	);
	error.status = status;
	return error;
}

/**
 * @param {string} url
 * @param {object} options advanced-http request options
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
function send(url, options, signal) {
	return new Promise((resolve, reject) => {
		const http = window.cordova?.plugin?.http;
		if (!http) {
			reject(new Error("Native HTTP is unavailable."));
			return;
		}
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			http.abort(requestId);
			reject(signal.reason);
		};
		const requestId = http.sendRequest(
			url,
			{
				responseType: "text",
				connectTimeout: 30,
				readTimeout: 600,
				...options,
			},
			(response) => {
				signal?.removeEventListener("abort", onAbort);
				resolve(response.data || "");
			},
			(failure) => {
				signal?.removeEventListener("abort", onAbort);
				reject(nativeError(failure));
			},
		);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<string>}
 */
export function nativeGetText(url, headers) {
	return send(url, { method: "GET", headers });
}

/**
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {string} body
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
export function nativePostText(url, headers, body, signal) {
	return send(
		url,
		{ method: "POST", headers, serializer: "utf8", data: body },
		signal,
	);
}
