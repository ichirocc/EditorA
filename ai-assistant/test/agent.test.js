import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
	createAnthropicAdapter,
	runAgentTurn,
	tidyApiError,
} from "../core/agent.js";
import { ToolInputError } from "../core/tools.js";

/**
 * A stand-in for client.beta.messages.stream that replays scripted replies.
 * Each reply is a message object, or an Error to reject finalMessage with.
 */
function fakeClient(replies) {
	const requests = [];
	const client = {
		beta: {
			messages: {
				stream(params, options) {
					// Copy the messages: the agent appends to the same array later.
					requests.push({ ...params, messages: [...params.messages], options });
					const reply = replies.shift();
					const handlers = {};
					return {
						on(event, handler) {
							handlers[event] = handler;
							return this;
						},
						async finalMessage() {
							if (reply instanceof Error) throw reply;
							for (const block of reply.content) {
								if (block.type === "text") handlers.text?.(block.text);
								if (block.type === "thinking") {
									handlers.thinking?.(block.thinking);
								}
							}
							return reply;
						},
					};
				},
			},
		},
	};
	return { client, requests };
}

const userMessage = () => [
	{ role: "user", content: [{ type: "text", text: "fix it" }] },
];

describe("AI assistant agent loop", () => {
	it("runs tools and loops until Claude ends its turn", async () => {
		const toolTurn = {
			stop_reason: "tool_use",
			content: [
				{ type: "thinking", thinking: "look first", signature: "s" },
				{ type: "text", text: "Reading." },
				{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
				{ type: "tool_use", id: "t2", name: "read_file", input: { path: "b" } },
			],
		};
		const finalTurn = {
			stop_reason: "end_turn",
			content: [{ type: "text", text: "Done." }],
		};
		const { client, requests } = fakeClient([toolTurn, finalTurn]);
		const messages = userMessage();
		const events = [];
		const executeTool = vi.fn(async (_name, input) => {
			if (input.path === "b") throw new ToolInputError("File not found: b");
			return "content of a";
		});

		await runAgentTurn({
			client,
			model: "claude-opus-5-5",
			system: "sys",
			messages,
			executeTool,
			onEvent: (event) => events.push(event),
		});

		expect(executeTool).toHaveBeenCalledTimes(2);
		// The assistant turn is kept verbatim, and both results share one message.
		expect(messages[1]).toEqual({
			role: "assistant",
			content: toolTurn.content,
		});
		expect(messages[2]).toEqual({
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "t1", content: "content of a" },
				{
					type: "tool_result",
					tool_use_id: "t2",
					content: "File not found: b",
					is_error: true,
				},
			],
		});
		expect(messages[3]).toEqual({
			role: "assistant",
			content: finalTurn.content,
		});
		expect(events.filter((e) => e.type === "text").map((e) => e.delta)).toEqual(
			["Reading.", "Done."],
		);
		expect(events.some((e) => e.type === "thinking")).toBe(true);

		// The second request carries the whole conversation so far.
		expect(requests[1].messages).toHaveLength(3);
	});

	it("requests Claude Opus 5.5 with adaptive thinking, fallbacks and caching", async () => {
		const { client, requests } = fakeClient([
			{ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
		]);
		const controller = new AbortController();
		await runAgentTurn({
			client,
			model: "claude-opus-5-5",
			system: "sys",
			messages: userMessage(),
			executeTool: vi.fn(),
			signal: controller.signal,
		});

		expect(requests[0]).toMatchObject({
			model: "claude-opus-5-5",
			max_tokens: 64000,
			betas: ["server-side-fallback-2026-07-01"],
			fallbacks: "default",
			thinking: { type: "adaptive", display: "summarized" },
			output_config: { effort: "high" },
			cache_control: { type: "ephemeral" },
			system: "sys",
		});
		expect(requests[0].tools.map((tool) => tool.name)).toContain("edit_file");
		expect(requests[0].options.signal).toBe(controller.signal);
	});

	it("never runs tools from a truncated or refused turn", async () => {
		for (const stop_reason of ["max_tokens", "refusal"]) {
			const { client } = fakeClient([
				{
					stop_reason,
					stop_details: { category: "cyber" },
					content: [
						{
							type: "tool_use",
							id: "t1",
							name: "write_file",
							input: { path: "a" },
						},
					],
				},
			]);
			const messages = userMessage();
			const executeTool = vi.fn();
			const events = [];

			await runAgentTurn({
				client,
				model: "m",
				system: "s",
				messages,
				executeTool,
				onEvent: (event) => events.push(event),
			});

			expect(executeTool).not.toHaveBeenCalled();
			expect(messages).toHaveLength(1);
			expect(events.at(-1).type).toBe(
				stop_reason === "refusal" ? "refusal" : "truncated",
			);
		}
	});

	it("re-issues a turn whose tool input was not valid JSON", async () => {
		const { client, requests } = fakeClient([
			new SyntaxError("Unexpected end of JSON input"),
			{ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
		]);
		const events = [];
		await runAgentTurn({
			client,
			model: "m",
			system: "s",
			messages: userMessage(),
			executeTool: vi.fn(),
			onEvent: (event) => events.push(event),
		});
		expect(requests).toHaveLength(2);
		expect(events[0]).toEqual({ type: "retry" });
	});

	it("rethrows API errors without retrying", async () => {
		const apiError = new Anthropic.AuthenticationError(
			401,
			{ type: "error" },
			"invalid x-api-key",
			new Headers(),
		);
		const { client, requests } = fakeClient([apiError]);
		await expect(
			runAgentTurn({
				client,
				model: "m",
				system: "s",
				messages: userMessage(),
				executeTool: vi.fn(),
			}),
		).rejects.toBe(apiError);
		expect(requests).toHaveLength(1);
	});

	it("stops before the next request once aborted, keeping tool results paired", async () => {
		const controller = new AbortController();
		const { client, requests } = fakeClient([
			{
				stop_reason: "tool_use",
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: "read_file",
						input: { path: "a" },
					},
				],
			},
		]);
		const messages = userMessage();
		const run = runAgentTurn({
			client,
			model: "m",
			system: "s",
			messages,
			executeTool: async () => {
				controller.abort();
				return "a";
			},
			signal: controller.signal,
		});

		await expect(run).rejects.toThrow();
		expect(requests).toHaveLength(1);
		expect(messages.at(-1).content[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: "t1",
		});
	});
});

describe("Anthropic adapter", () => {
	it("shortens API errors to the API's explanation, keeping the error", () => {
		const error = new Anthropic.AuthenticationError(
			401,
			{
				type: "error",
				error: { type: "authentication_error", message: "invalid x-api-key" },
			},
			undefined,
			new Headers(),
		);
		expect(tidyApiError(error)).toBe(error);
		expect(error.message).toBe("401: invalid x-api-key");
		expect(error.status).toBe(401);
		const abort = new Anthropic.APIUserAbortError();
		expect(tidyApiError(abort).message).toBe("Request was aborted.");
		expect(abort.network).toBeUndefined();
		const offline = new Anthropic.APIConnectionError({});
		expect(tidyApiError(offline).network).toBe(true);
	});

	it("builds user messages from text blocks and keeps a changeable model", () => {
		const adapter = createAnthropicAdapter({
			apiKey: "sk-ant",
			model: "claude-opus-5-5",
		});
		expect(adapter.userMessage(["<app_state>", "hi"])).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "<app_state>" },
				{ type: "text", text: "hi" },
			],
		});
		adapter.model = "claude-sonnet-5-5";
		expect(adapter.model).toBe("claude-sonnet-5-5");
	});
});
