/**
 * Model providers the assistant can use. Anthropic goes through its SDK;
 * every other provider is reached through its OpenAI-compatible Chat
 * Completions API, so a new one only needs an entry here.
 *
 * Model names change often, so only Anthropic, DeepSeek and Gemini have a
 * default; the settings dialog lists the provider's current models from
 * `/models`.
 *
 * Open-weight models (Llama, Qwen, gpt-oss, DeepSeek, Kimi, GLM, …) can be
 * used through the services that host them, or run on the device itself
 * with Ollama, LM Studio or llama.cpp, which need no API key.
 */

/**
 * @typedef {object} Provider
 * @property {string} id
 * @property {string} label
 * @property {"anthropic"|"openai"} kind
 * @property {string} [baseUrl] OpenAI-compatible API root
 * @property {string} [defaultModel]
 * @property {string} [secretName] encrypted-storage name of the API key
 * @property {"vendor"|"hosted"|"local"|"other"} group how the settings
 *   group the providers: a model maker's own API, a service hosting open
 *   models, a model server on this device, or any other API
 * @property {boolean} [keyOptional] works without an API key
 */

/**@type {Provider[]} */
export const PROVIDERS = [
	{
		id: "anthropic",
		label: "Anthropic Claude",
		kind: "anthropic",
		group: "vendor",
		defaultModel: "claude-opus-5-5",
		secretName: "anthropic_api_key",
	},
	{
		id: "deepseek",
		label: "DeepSeek",
		kind: "openai",
		group: "vendor",
		baseUrl: "https://api.deepseek.com",
		// DeepSeek's alias for its latest model.
		defaultModel: "deepseek-flash",
	},
	{
		id: "openai",
		label: "OpenAI",
		kind: "openai",
		group: "vendor",
		baseUrl: "https://api.openai.com/v1",
	},
	{
		id: "gemini",
		label: "Google Gemini",
		kind: "openai",
		group: "vendor",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
		// A Flash model the free tier covers. Checked against the live API in
		// October 2026, the newest Flash models (and the gemini-flash-latest
		// alias) were too overloaded to finish a tool turn; this one was fast.
		defaultModel: "gemini-3.5-flash",
	},
	{
		id: "xai",
		label: "xAI Grok",
		kind: "openai",
		group: "vendor",
		baseUrl: "https://api.x.ai/v1",
	},
	{
		id: "moonshot",
		label: "Moonshot Kimi",
		kind: "openai",
		group: "vendor",
		baseUrl: "https://api.moonshot.ai/v1",
	},
	{
		id: "qwen",
		label: "Alibaba Qwen",
		kind: "openai",
		group: "vendor",
		baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
	},
	{
		id: "zai",
		label: "Z.ai GLM",
		kind: "openai",
		group: "vendor",
		baseUrl: "https://api.z.ai/api/paas/v4",
	},
	{
		id: "mistral",
		label: "Mistral",
		kind: "openai",
		group: "vendor",
		baseUrl: "https://api.mistral.ai/v1",
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		kind: "openai",
		group: "hosted",
		baseUrl: "https://openrouter.ai/api/v1",
	},
	{
		id: "huggingface",
		label: "Hugging Face",
		kind: "openai",
		group: "hosted",
		// Routes each model to one of the inference providers serving it.
		baseUrl: "https://router.huggingface.co/v1",
	},
	{
		id: "groq",
		label: "Groq",
		kind: "openai",
		group: "hosted",
		baseUrl: "https://api.groq.com/openai/v1",
	},
	{
		id: "together",
		label: "Together AI",
		kind: "openai",
		group: "hosted",
		baseUrl: "https://api.together.xyz/v1",
	},
	{
		id: "fireworks",
		label: "Fireworks AI",
		kind: "openai",
		group: "hosted",
		baseUrl: "https://api.fireworks.ai/inference/v1",
	},
	{
		id: "ollama",
		label: "Ollama",
		kind: "openai",
		group: "local",
		baseUrl: "http://localhost:11434/v1",
		keyOptional: true,
	},
	{
		id: "lmstudio",
		label: "LM Studio",
		kind: "openai",
		group: "local",
		baseUrl: "http://localhost:1234/v1",
		keyOptional: true,
	},
	{
		id: "llamacpp",
		label: "llama.cpp",
		kind: "openai",
		group: "local",
		// llama-server's default port.
		baseUrl: "http://localhost:8080/v1",
		keyOptional: true,
	},
	{
		id: "custom",
		label: "Custom",
		kind: "openai",
		group: "other",
		baseUrl: "",
		keyOptional: true,
	},
];

/**
 * The provider a new setup starts with. Gemini has a free tier: an API key
 * from Google AI Studio costs nothing, within daily limits.
 */
export const DEFAULT_PROVIDER_ID = "gemini";

/**
 * @param {string} id
 * @returns {Provider} the default provider for an unknown id
 */
export function getProvider(id) {
	return (
		PROVIDERS.find((provider) => provider.id === id) ||
		PROVIDERS.find((provider) => provider.id === DEFAULT_PROVIDER_ID)
	);
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

// How long a model server that needs no key may take to answer.
const LOCAL_NO_ANSWER_MS = 15 * 60_000;

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
		// Servers that need no key mostly run on the user's own machine,
		// where reading a long prompt can take minutes before any answer.
		...(provider.keyOptional ? { noAnswerMs: LOCAL_NO_ANSWER_MS } : {}),
	});
}
