/**
 * Model providers the assistant can use. Anthropic goes through its SDK;
 * every other provider is reached through its OpenAI-compatible Chat
 * Completions API, so a new one only needs an entry here.
 *
 * Model names change often, so only Anthropic and DeepSeek have a default;
 * the settings dialog lists the provider's current models from `/models`.
 */

/**
 * @typedef {object} Provider
 * @property {string} id
 * @property {string} label
 * @property {"anthropic"|"openai"} kind
 * @property {string} [baseUrl] OpenAI-compatible API root
 * @property {string} [defaultModel]
 * @property {string} [secretName] encrypted-storage name of the API key
 */

/**@type {Provider[]} */
export const PROVIDERS = [
	{
		id: "anthropic",
		label: "Anthropic Claude",
		kind: "anthropic",
		defaultModel: "claude-opus-5-5",
		secretName: "anthropic_api_key",
	},
	{
		id: "deepseek",
		label: "DeepSeek",
		kind: "openai",
		baseUrl: "https://api.deepseek.com",
		// DeepSeek's alias for its latest model.
		defaultModel: "deepseek-flash",
	},
	{
		id: "openai",
		label: "OpenAI",
		kind: "openai",
		baseUrl: "https://api.openai.com/v1",
	},
	{
		id: "gemini",
		label: "Google Gemini",
		kind: "openai",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
	},
	{
		id: "xai",
		label: "xAI Grok",
		kind: "openai",
		baseUrl: "https://api.x.ai/v1",
	},
	{
		id: "moonshot",
		label: "Moonshot Kimi",
		kind: "openai",
		baseUrl: "https://api.moonshot.ai/v1",
	},
	{
		id: "qwen",
		label: "Alibaba Qwen",
		kind: "openai",
		baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
	},
	{
		id: "zai",
		label: "Z.ai GLM",
		kind: "openai",
		baseUrl: "https://api.z.ai/api/paas/v4",
	},
	{
		id: "mistral",
		label: "Mistral",
		kind: "openai",
		baseUrl: "https://api.mistral.ai/v1",
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		kind: "openai",
		baseUrl: "https://openrouter.ai/api/v1",
	},
	{ id: "custom", label: "Custom", kind: "openai", baseUrl: "" },
];

/**
 * @param {string} id
 * @returns {Provider}
 */
export function getProvider(id) {
	return PROVIDERS.find((provider) => provider.id === id) || PROVIDERS[0];
}

/**
 * Encrypted-storage name of a provider's API key.
 * @param {Provider} provider
 * @returns {string}
 */
export function secretNameFor(provider) {
	return provider.secretName || `ai_key_${provider.id}`;
}

/**
 * API roots the app can reach: HTTPS, or plain HTTP to a server on the
 * device itself (cleartext traffic is otherwise disabled).
 * @param {string} url
 * @returns {boolean}
 */
export function isAllowedBaseUrl(url) {
	return (
		/^https:\/\/[^/\s]+/i.test(url) ||
		/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(url)
	);
}

/**
 * Creates the adapter a session talks to. The Anthropic SDK and the
 * OpenAI-compatible client are loaded only when used.
 * @param {object} options
 * @param {Provider} options.provider
 * @param {string} options.model
 * @param {string} [options.baseUrl] overrides the provider's API root
 * @param {string} options.apiKey
 * @param {boolean} [options.browser] running in a browser or WebView, so the
 *   Anthropic SDK must be allowed to call the API from there
 * @param {(url:string, headers:Record<string,string>) => Promise<string>} [options.nativeGet]
 * @param {(url:string, headers:Record<string,string>, body:string, signal?:AbortSignal) => Promise<string>} [options.nativePost]
 *   requests that bypass CORS (the editor's native HTTP plugin); in Node
 *   they are not needed
 * @returns {Promise<import("./session.js").ModelAdapter & {listModels: () => Promise<string[]>}>}
 */
export async function createModelAdapter({
	provider,
	model,
	baseUrl,
	apiKey,
	browser = false,
	nativeGet = null,
	nativePost = null,
}) {
	if (provider.kind === "anthropic") {
		const { createAnthropicAdapter } = await import("./agent.js");
		return createAnthropicAdapter({ apiKey, model, browser });
	}
	const { createOpenAICompatibleAdapter } = await import(
		"./openaiCompatible.js"
	);
	return createOpenAICompatibleAdapter({
		baseUrl: baseUrl || provider.baseUrl,
		apiKey,
		model,
		nativeGet,
		nativePost,
	});
}
