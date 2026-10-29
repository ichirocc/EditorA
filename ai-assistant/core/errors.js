/**
 * The human-readable message in an API error body. Providers wrap it
 * differently: {error: {message}}, {message}, {error: "..."}, or, like
 * Gemini, an array of such objects.
 * @param {string} text response body
 * @returns {string} the message, or the body itself if none is found
 */
export function apiErrorMessage(text) {
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		return text;
	}
	const item = Array.isArray(data) ? data[0] : data;
	return (
		item?.error?.message ||
		item?.message ||
		(typeof item?.error === "string" ? item.error : "") ||
		text
	);
}
