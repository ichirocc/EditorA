import { apiErrorMessage } from "./errors.js";
import { TOOLS, ToolInputError } from "./tools.js";

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
	/embed|tts|whisper|dall-e|image|audio|realtime|moderation|transcri|rerank|speech|vision-exp|lyria|nano-banana|robotics|computer-use|deep-research|-live\b|^aqa$/i;
// Overloaded or rate-limited: worth trying again after a pause.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [2000, 6000];
// A request that receives nothing for this long is given up: Gemini
// sometimes keeps a request open without ever answering.
const NO_ANSWER_MS = 3 * 60_000;
// Model types (Together AI) other than chat; "language" is a base model.
const NON_CHAT_TYPE =
	/^(?:embedding|image|rerank|moderation|audio|video|transcribe|language)$/;

/**
 * Whether a `/models` entry can serve the assistant: a chat model and, where
 * the API says (Hugging Face lists each model's providers), one that some
 * provider runs with tool calling.
 * @param {any} entry
 * @param {string} id
 */
function isChatModel(entry, id) {
	if (!id || NON_CHAT_MODEL.test(id)) return false;
	if (typeof entry.type === "string" && NON_CHAT_TYPE.test(entry.type)) {
		return false;
	}
	if (Array.isArray(entry.providers) && entry.providers.length) {
		return entry.providers.some((provider) => provider?.supports_tools);
	}
	return true;
}

/** The assistant's tools in Chat Completions format. */
/**
 * A tool's input schema for Chat Completions. Gemini rejects an object
 * schema without properties (and one left out), so a tool that takes no
 * input gets one optional property that the app ignores; empty `required`
 * lists are left out too.
 * @param {any} schema
 */
function chatParameters({ properties = {}, required = [], ...schema }) {
	return {
		...schema,
		properties: Object.keys(properties).length
			? properties
			: {
					reason: {
						type: "string",
						description: "Optional. Not used by the app.",
					},
				},
		...(required.length ? { required } : {}),
	};
}

export const OPENAI_TOOLS = TOOLS.map(
	({ name, description, input_schema }) => ({
		type: "function",
		function: { name, description, parameters: chatParameters(input_schema) },
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
	const message = apiErrorMessage(text);
	return new ProviderError(
		`${status ? `${status}: ` : ""}${String(message || "Request failed").slice(0, 500)}`,
		status,
	);
}

/**
 * The error for a request that never reached the API: fetch only says
 * "fetch failed", which does not tell which server is down.
 * @param {string} url
 * @param {any} error
 */
function unreachable(url, error) {
	const cause = error?.cause?.code || error?.cause?.message || error?.message;
	const failure = new ProviderError(
		`Could not connect to ${new URL(url).host}${cause ? ` (${cause})` : ""}.`,
		0,
	);
	failure.network = true;
	return failure;
}

/**
 * The error for a request that received nothing for `ms`.
 * @param {number} ms
 */
function noAnswer(ms) {
	const wait =
		ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${ms / 1000} s`;
	const failure = new ProviderError(
		`No answer from the model for ${wait}. It may be overloaded or stuck: send again, or choose another model.`,
		0,
	);
	failure.noAnswerMs = ms;
	return failure;
}

/**
 * A signal for one request that follows the caller's signal and is also
 * aborted, with a noAnswer() error, when `alive()` is not called for `ms`.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
function watchdog(ms, signal) {
	const controller = new AbortController();
	const stop = () => controller.abort(signal.reason);
	if (signal?.aborted) stop();
	else signal?.addEventListener("abort", stop, { once: true });
	let timer;
	const alive = () => {
		clearTimeout(timer);
		timer = setTimeout(() => controller.abort(noAnswer(ms)), ms);
	};
	alive();
	return {
		signal: controller.signal,
		alive,
		done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", stop);
		},
	};
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
function pause(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

/**
 * Yields the JSON chunks of a server-sent event stream.
 * @param {ReadableStream<Uint8Array>} body
 * @param {() => void} onData called whenever bytes arrive, keep-alives too
 */
async function* readEvents(body, onData) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { value, done } = await reader.read();
		if (value) onData();
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
 * @property {{id:string, name:string, arguments:string, extra_content?:any}[]} toolCalls
 *   `extra_content` carries Gemini's thought signature, which must be sent
 *   back with the call
 * @property {Map<number, Reply["toolCalls"][number]>} slots the call each
 *   stream index is adding to
 * @property {string|null} finish
 */

/**
 * Adds one streamed chunk, or a whole non-streamed response, to a reply.
 * @param {Reply} reply
 * @param {any} chunk
 * @param {(event:import("./agent.js").AgentEvent) => void} onEvent
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
		const key = call.index ?? -1;
		let slot = reply.slots.get(key);
		// A new id starts a new call, also where an API numbers every call 0
		// or leaves the index out.
		if (!slot || (call.id && slot.id && call.id !== slot.id)) {
			slot = { id: "", name: "", arguments: "" };
			reply.toolCalls.push(slot);
			reply.slots.set(key, slot);
		}
		if (call.id) slot.id = call.id;
		if (call.function?.name && !slot.name) slot.name = call.function.name;
		if (call.function?.arguments) slot.arguments += call.function.arguments;
		if (call.extra_content) slot.extra_content = call.extra_content;
	}
	if (choice.finish_reason) reply.finish = choice.finish_reason;
}

/**
 * @param {object} options
 * @param {string} options.baseUrl API root, e.g. "https://api.deepseek.com"
 * @param {string} [options.apiKey] empty for servers that need none
 * @param {string} options.model
 * @param {typeof fetch} [options.fetch]
 * @param {(url:string, headers:Record<string,string>) => Promise<string>} [options.nativeGet]
 * @param {(url:string, headers:Record<string,string>, body:string, signal?:AbortSignal) => Promise<string>} [options.nativePost]
 * @param {number[]} [options.retryDelays] pauses (ms) before each retry of an
 *   overloaded or rate-limited request
 * @param {number} [options.noAnswerMs] how long a request may receive
 *   nothing before it is given up; without streaming, the whole reply has
 *   to arrive within it
 * @returns {import("./session.js").ModelAdapter & {listModels: () => Promise<string[]>}}
 */
export function createOpenAICompatibleAdapter({
	baseUrl,
	apiKey,
	model,
	fetch: fetchImpl = fetch,
	nativeGet = null,
	nativePost = null,
	retryDelays = RETRY_DELAYS_MS,
	noAnswerMs = NO_ANSWER_MS,
}) {
	const root = baseUrl.replace(/\/+$/, "");
	// Local model servers (Ollama, LM Studio, llama.cpp) need no key.
	const auth = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
	// Set once a native request worked after fetch failed: fetch is then
	// blocked (CORS), not the network, so later requests skip it.
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
			slots: new Map(),
			finish: null,
		};
		const url = `${root}/chat/completions`;
		const headers = { ...auth, "Content-Type": "application/json" };
		const watch = watchdog(noAnswerMs, signal);

		try {
			if (!useNative) {
				let response = null;
				try {
					response = await fetchImpl(url, {
						method: "POST",
						headers: { ...headers, Accept: "text/event-stream" },
						body: JSON.stringify({ ...body, stream: true }),
						signal: watch.signal,
					});
				} catch (error) {
					if (watch.signal.aborted) throw error;
					// Offline: the native request would fail the same way.
					if (!nativePost || globalThis.navigator?.onLine === false) {
						throw unreachable(url, error);
					}
				}
				if (response) {
					if (!response.ok) {
						throw providerError(response.status, await response.text());
					}
					for await (const chunk of readEvents(response.body, watch.alive)) {
						addChunk(reply, chunk, onEvent);
					}
					return reply;
				}
			}

			const text = await nativePost(
				url,
				headers,
				JSON.stringify({ ...body, stream: false }),
				watch.signal,
			);
			useNative = true;
			addChunk(reply, JSON.parse(text), onEvent);
			return reply;
		} catch (error) {
			// Given up for lack of an answer: say so, not "aborted".
			if (watch.signal.aborted && !signal?.aborted) {
				throw watch.signal.reason;
			}
			throw error;
		} finally {
			watch.done();
		}
	}

	/**
	 * complete(), tried again after a pause while the API is overloaded or
	 * rate-limited (Gemini's free tier often answers 503 or 429). Such an
	 * answer comes before any output, so nothing is shown twice.
	 * @param {object} body
	 * @param {(event:any) => void} onEvent
	 * @param {AbortSignal} [signal]
	 */
	async function completeWithRetry(body, onEvent, signal) {
		for (let attempt = 0; ; attempt++) {
			try {
				return await complete(body, onEvent, signal);
			} catch (error) {
				const delay = retryDelays[attempt];
				if (delay === undefined || !RETRY_STATUS.has(error?.status))
					throw error;
				onEvent({ type: "retry" });
				await pause(delay, signal);
			}
		}
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
		 * @param {(event:import("./agent.js").AgentEvent) => void} [options.onEvent]
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
				const reply = await completeWithRetry(
					{
						model: this.model,
						messages: [{ role: "system", content: system }, ...messages],
						tools: OPENAI_TOOLS,
						tool_choice: "auto",
					},
					onEvent,
					signal,
				);
				const calls = reply.toolCalls.map((call, i) => ({
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
					assistant.tool_calls = calls.map(
						({ id, name, arguments: args, extra_content }) => ({
							id,
							type: "function",
							function: { name, arguments: args || "{}" },
							// Gemini rejects a call sent back without its signature.
							...(extra_content ? { extra_content } : {}),
						}),
					);
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
				if (error instanceof ProviderError) throw error;
				if (!nativeGet) throw unreachable(url, error);
				text = await nativeGet(url, auth);
			}
			const data = JSON.parse(text);
			// Together AI returns a bare array.
			const entries = Array.isArray(data) ? data : data.data || data.models;
			return (entries || [])
				.map((entry) => ({
					entry,
					id: String(entry.id || entry.name || "").replace(/^models\//, ""),
				}))
				.filter(({ entry, id }) => isChatModel(entry, id))
				.map(({ id }) => id)
				.sort();
		},
	};
}
