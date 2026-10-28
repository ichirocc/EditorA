import { TOOLS, ToolInputError } from "./tools";

/**
 * Agent loop for providers with an OpenAI-compatible Chat Completions API
 * (DeepSeek, OpenAI, Gemini, Grok, Kimi, Qwen, GLM, Mistral, OpenRouter...).
 *
 * Replies stream over `fetch` when the provider allows browser requests.
 * If `fetch` fails before any response (a provider without CORS headers),
 * requests go through the native HTTP plugin instead, without streaming.
 */

const MAX_ROUNDS = 60;
// Model ids that are clearly not chat models, hidden from the model list.
const NON_CHAT_MODEL =
	/embed|tts|whisper|dall-e|image|audio|realtime|moderation|transcri|rerank|speech|vision-exp/i;

/** The assistant's tools in Chat Completions format. */
export const OPENAI_TOOLS = TOOLS.map(
	({ name, description, input_schema }) => ({
		type: "function",
		function: { name, description, parameters: input_schema },
	}),
);

export class ProviderError extends Error {
	/**
	 * @param {string} message
	 * @param {number} status HTTP status, 0 when unknown
	 */
	constructor(message, status) {
		super(message);
		this.name = "ProviderError";
		this.status = status;
	}
}

/**
 * Builds an error from a failed HTTP response body.
 * @param {number} status
 * @param {string} text
 * @returns {ProviderError}
 */
export function providerError(status, text) {
	let message = text;
	try {
		const data = JSON.parse(text);
		message =
			data?.error?.message ||
			data?.message ||
			(typeof data?.error === "string" ? data.error : text);
	} catch {
		// Not JSON: keep the text.
	}
	return new ProviderError(
		`${status ? `${status}: ` : ""}${String(message || "Request failed").slice(0, 500)}`,
		status,
	);
}

/**
 * Yields the JSON chunks of a server-sent event stream.
 * @param {ReadableStream<Uint8Array>} body
 */
async function* readEvents(body) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { value, done } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		const lines = buffer.split("\n");
		buffer = done ? "" : lines.pop();
		for (const raw of lines) {
			const line = raw.trim();
			if (!line.startsWith("data:")) continue; // comments and keep-alives
			const payload = line.slice(5).trim();
			if (payload === "[DONE]") return;
			yield JSON.parse(payload);
		}
		if (done) return;
	}
}

/**
 * @typedef {object} Reply
 * @property {string} content
 * @property {string} reasoning
 * @property {boolean} reasoningContent the reasoning came as `reasoning_content`
 * @property {{id:string, name:string, arguments:string}[]} toolCalls
 * @property {string|null} finish
 */

/**
 * Adds one streamed chunk, or a whole non-streamed response, to a reply.
 * @param {Reply} reply
 * @param {any} chunk
 * @param {(event:import("./agent").AgentEvent) => void} onEvent
 */
function addChunk(reply, chunk, onEvent) {
	if (chunk.error) {
		throw providerError(0, JSON.stringify(chunk));
	}
	const choice = chunk.choices?.[0];
	if (!choice) return;
	const delta = choice.delta || choice.message || {};
	if (typeof delta.content === "string" && delta.content) {
		reply.content += delta.content;
		onEvent({ type: "text", delta: delta.content });
	}
	// DeepSeek, Kimi and Qwen use reasoning_content; OpenRouter uses reasoning.
	const reasoning = delta.reasoning_content ?? delta.reasoning;
	if (typeof reasoning === "string" && reasoning) {
		reply.reasoning += reasoning;
		reply.reasoningContent ||= typeof delta.reasoning_content === "string";
		onEvent({ type: "thinking", delta: reasoning });
	}
	for (const call of delta.tool_calls || []) {
		const index = call.index ?? reply.toolCalls.length;
		reply.toolCalls[index] ??= { id: "", name: "", arguments: "" };
		const slot = reply.toolCalls[index];
		if (call.id) slot.id = call.id;
		if (call.function?.name && !slot.name) slot.name = call.function.name;
		if (call.function?.arguments) slot.arguments += call.function.arguments;
	}
	if (choice.finish_reason) reply.finish = choice.finish_reason;
}

/**
 * @param {object} options
 * @param {string} options.baseUrl API root, e.g. "https://api.deepseek.com"
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {typeof fetch} [options.fetch]
 * @param {(url:string, headers:Record<string,string>) => Promise<string>} [options.nativeGet]
 * @param {(url:string, headers:Record<string,string>, body:string, signal?:AbortSignal) => Promise<string>} [options.nativePost]
 * @returns {import("./session").ModelAdapter & {listModels: () => Promise<string[]>}}
 */
export function createOpenAICompatibleAdapter({
	baseUrl,
	apiKey,
	model,
	fetch: fetchImpl = fetch,
	nativeGet = null,
	nativePost = null,
}) {
	const root = baseUrl.replace(/\/+$/, "");
	const auth = { Authorization: `Bearer ${apiKey}` };
	let useNative = false;

	/**
	 * @param {object} body request without `stream`
	 * @param {(event:any) => void} onEvent
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<Reply>}
	 */
	async function complete(body, onEvent, signal) {
		/**@type {Reply} */
		const reply = {
			content: "",
			reasoning: "",
			reasoningContent: false,
			toolCalls: [],
			finish: null,
		};
		const url = `${root}/chat/completions`;
		const headers = { ...auth, "Content-Type": "application/json" };

		if (!useNative) {
			let response = null;
			try {
				response = await fetchImpl(url, {
					method: "POST",
					headers: { ...headers, Accept: "text/event-stream" },
					body: JSON.stringify({ ...body, stream: true }),
					signal,
				});
			} catch (error) {
				if (signal?.aborted || !nativePost) throw error;
				useNative = true;
			}
			if (response) {
				if (!response.ok) {
					throw providerError(response.status, await response.text());
				}
				for await (const chunk of readEvents(response.body)) {
					addChunk(reply, chunk, onEvent);
				}
				return reply;
			}
		}

		const text = await nativePost(
			url,
			headers,
			JSON.stringify({ ...body, stream: false }),
			signal,
		);
		addChunk(reply, JSON.parse(text), onEvent);
		return reply;
	}

	return {
		model,

		/**
		 * @param {string[]} texts
		 */
		userMessage(texts) {
			return { role: "user", content: texts.join("\n\n") };
		},

		/**
		 * Same contract as runAgentTurn: appends to `messages` only, and every
		 * tool call gets its result before returning.
		 * @param {object} options
		 * @param {string} options.system
		 * @param {any[]} options.messages
		 * @param {(name:string, input:any) => Promise<string>} options.executeTool
		 * @param {(event:import("./agent").AgentEvent) => void} [options.onEvent]
		 * @param {AbortSignal} [options.signal]
		 */
		async runTurn({
			system,
			messages,
			executeTool,
			onEvent = () => {},
			signal,
		}) {
			for (let round = 0; round < MAX_ROUNDS; round++) {
				signal?.throwIfAborted();
				const reply = await complete(
					{
						model: this.model,
						messages: [{ role: "system", content: system }, ...messages],
						tools: OPENAI_TOOLS,
						tool_choice: "auto",
					},
					onEvent,
					signal,
				);
				const calls = reply.toolCalls.filter(Boolean).map((call, i) => ({
					...call,
					id: call.id || `call_${messages.length}_${i}`,
				}));

				if (reply.finish === "content_filter") {
					onEvent({ type: "refusal", category: null });
					return;
				}
				if (reply.finish === "length" && calls.length) {
					// The last tool call's arguments may be cut off; never run it.
					onEvent({ type: "truncated" });
					return;
				}

				const assistant = { role: "assistant", content: reply.content };
				if (calls.length) {
					assistant.tool_calls = calls.map(({ id, name, arguments: args }) => ({
						id,
						type: "function",
						function: { name, arguments: args || "{}" },
					}));
					// Thinking models (DeepSeek, Kimi) need their reasoning back
					// while they are still calling tools in the same turn.
					if (reply.reasoningContent) {
						assistant.reasoning_content = reply.reasoning;
					}
				}
				messages.push(assistant);
				onEvent({ type: "message", message: assistant });

				if (reply.finish === "length") {
					onEvent({ type: "truncated" });
					return;
				}
				if (!calls.length) return;

				for (const call of calls) {
					let result;
					let isError = false;
					let input = null;
					try {
						input = JSON.parse(call.arguments || "{}");
						result = await executeTool(call.name, input);
					} catch (error) {
						isError = true;
						result =
							error instanceof SyntaxError
								? `INVALID_JSON: the arguments for ${call.name} were not valid JSON.`
								: error instanceof ToolInputError
									? error.message
									: `Tool failed: ${error?.message || error}`;
					}
					onEvent({ type: "tool", name: call.name, input, result, isError });
					messages.push({
						role: "tool",
						tool_call_id: call.id,
						content: isError ? `Error: ${result}` : result,
					});
				}
			}
			throw new Error(
				`Stopped after ${MAX_ROUNDS} tool rounds. Send a message to continue.`,
			);
		},

		/**
		 * The provider's chat model ids, sorted.
		 * @returns {Promise<string[]>}
		 */
		async listModels() {
			const url = `${root}/models`;
			let text;
			try {
				const response = await fetchImpl(url, { headers: auth });
				text = await response.text();
				if (!response.ok) throw providerError(response.status, text);
			} catch (error) {
				if (error instanceof ProviderError || !nativeGet) throw error;
				text = await nativeGet(url, auth);
			}
			const data = JSON.parse(text);
			return (data.data || data.models || [])
				.map((entry) =>
					String(entry.id || entry.name || "").replace(/^models\//, ""),
				)
				.filter((id) => id && !NON_CHAT_MODEL.test(id))
				.sort();
		},
	};
}
