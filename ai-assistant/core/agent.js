import Anthropic from "@anthropic-ai/sdk";
import { TOOLS, ToolInputError } from "./tools.js";

export const DEFAULT_MODEL = "claude-opus-5-5";

// Server-side fallback re-runs a request another model can answer when the
// requested model's safety classifiers decline it.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_TOKENS = 64_000;
const MAX_JSON_RETRIES = 2;
const MAX_ROUNDS = 60;

/**
 * @param {string} apiKey
 * @param {{browser?:boolean}} [options] `browser` allows calling the API
 *   from a browser or WebView; the editor does this because the key belongs
 *   to the user and stays on their device
 * @returns {Anthropic}
 */
export function createClaudeClient(apiKey, { browser = false } = {}) {
	return new Anthropic({ apiKey, dangerouslyAllowBrowser: browser });
}

/**
 * @typedef {{type:"text", delta:string}
 *   | {type:"thinking", delta:string}
 *   | {type:"tool", name:string, input:any, result:string, isError:boolean}
 *   | {type:"retry"}
 *   | {type:"fallback", from:string, to:string}
 *   | {type:"refusal", category:string|null}
 *   | {type:"truncated"}
 *   | {type:"message", message:any}} AgentEvent
 */

/**
 * Runs one user turn: streams Claude's reply, runs the tools it calls and
 * loops until it ends its turn.
 *
 * `messages` is only ever appended to, and assistant content is appended
 * exactly as received, so cached prefixes and thinking blocks stay valid.
 * A tool_use is always followed by its tool_result before this returns, so
 * an abort never leaves the conversation in a state the API rejects.
 *
 * @param {object} options
 * @param {Anthropic} options.client
 * @param {string} options.model
 * @param {string} options.system
 * @param {any[]} options.messages conversation, ending with the user's message
 * @param {(name:string, input:any) => Promise<string>} options.executeTool
 * @param {(event:AgentEvent) => void} [options.onEvent]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<void>}
 */
export async function runAgentTurn({
	client,
	model,
	system,
	messages,
	executeTool,
	onEvent = () => {},
	signal,
}) {
	let jsonRetries = 0;

	for (let round = 0; round < MAX_ROUNDS; round++) {
		signal?.throwIfAborted();

		const stream = client.beta.messages.stream(
			{
				model,
				max_tokens: MAX_TOKENS,
				betas: [FALLBACK_BETA],
				fallbacks: "default",
				thinking: { type: "adaptive", display: "summarized" },
				output_config: { effort: "high" },
				cache_control: { type: "ephemeral" },
				system,
				tools: TOOLS,
				messages,
			},
			{ signal },
		);
		stream.on("text", (delta) => onEvent({ type: "text", delta }));
		stream.on("thinking", (delta) => onEvent({ type: "thinking", delta }));

		let message;
		try {
			message = await stream.finalMessage();
			jsonRetries = 0;
		} catch (error) {
			// With eager input streaming a tool input that is not valid JSON
			// rejects here. Only that case is retried; API errors and aborts
			// (APIUserAbortError is an APIError) are rethrown.
			if (
				error instanceof Anthropic.APIError ||
				signal?.aborted ||
				jsonRetries++ >= MAX_JSON_RETRIES
			) {
				throw error;
			}
			onEvent({ type: "retry" });
			continue;
		}

		const toolUses = message.content.filter(
			(block) => block.type === "tool_use",
		);

		if (message.stop_reason === "refusal") {
			// A refusal can cut a tool_use off mid-input; keep the reply out of
			// the history so the next turn starts from a valid conversation.
			onEvent({
				type: "refusal",
				category: message.stop_details?.category ?? null,
			});
			return;
		}

		if (message.stop_reason === "max_tokens" && toolUses.length) {
			// The truncated tool input may still parse; never run it.
			onEvent({ type: "truncated" });
			return;
		}

		messages.push({ role: "assistant", content: message.content });
		onEvent({ type: "message", message });

		if (message.stop_reason === "pause_turn") continue;
		if (message.stop_reason === "max_tokens") {
			onEvent({ type: "truncated" });
			return;
		}
		if (!toolUses.length) return;

		const results = [];
		for (const toolUse of toolUses) {
			let result;
			let isError = false;
			try {
				result = await executeTool(toolUse.name, toolUse.input);
			} catch (error) {
				isError = true;
				result =
					error instanceof ToolInputError
						? error.message
						: `Tool failed: ${error?.message || error}`;
			}
			onEvent({
				type: "tool",
				name: toolUse.name,
				input: toolUse.input,
				result,
				isError,
			});
			results.push({
				type: "tool_result",
				tool_use_id: toolUse.id,
				content: result,
				...(isError ? { is_error: true } : {}),
			});
		}
		// All results go back in one user message so Claude keeps calling
		// tools in parallel.
		messages.push({ role: "user", content: results });
	}

	throw new Error(
		`Stopped after ${MAX_ROUNDS} tool rounds. Send a message to continue.`,
	);
}

/**
 * Shortens an API error's message to the API's own explanation, e.g.
 * "401: invalid x-api-key" instead of the status and the whole JSON body.
 * The error object itself (its class and status) is kept.
 * @param {unknown} error
 * @returns {unknown} the same error
 */
export function tidyApiError(error) {
	if (
		error instanceof Anthropic.APIError &&
		!(error instanceof Anthropic.APIUserAbortError)
	) {
		const detail = error.error?.error?.message;
		if (detail) error.message = `${error.status}: ${detail}`;
	}
	// The request never reached the API (offline, dropped connection).
	if (error instanceof Anthropic.APIConnectionError) error.network = true;
	return error;
}

/**
 * Session adapter for Claude.
 * @param {{apiKey:string, model:string, browser?:boolean}} options
 * @returns {import("./session.js").ModelAdapter & {listModels: () => Promise<string[]>}}
 */
export function createAnthropicAdapter({ apiKey, model, browser = false }) {
	const client = createClaudeClient(apiKey, { browser });
	return {
		model,
		userMessage(texts) {
			return {
				role: "user",
				content: texts.map((text) => ({ type: "text", text })),
			};
		},
		async runTurn(options) {
			try {
				return await runAgentTurn({ client, model: this.model, ...options });
			} catch (error) {
				throw tidyApiError(error);
			}
		},
		async listModels() {
			const ids = [];
			try {
				for await (const entry of client.models.list()) ids.push(entry.id);
			} catch (error) {
				throw tidyApiError(error);
			}
			return ids;
		},
	};
}
