import { describe, expect, it, vi } from "vitest";
import {
	createOpenAICompatibleAdapter,
	OPENAI_TOOLS,
	ProviderError,
} from "../core/openaiCompatible.js";
import { ToolInputError } from "../core/tools.js";

/**
 * A streamed response whose bytes arrive in awkward pieces, to exercise the
 * SSE line buffering.
 * @param {object[]} chunks chat completion chunks
 */
function sseResponse(chunks) {
	const text = `: keep-alive\n\n${chunks
		.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
		.join("")}data: [DONE]\n\n`;
	const bytes = new TextEncoder().encode(text);
	const stream = new ReadableStream({
		start(controller) {
			for (let i = 0; i < bytes.length; i += 7) {
				controller.enqueue(bytes.slice(i, i + 7));
			}
			controller.close();
		},
	});
	return new Response(stream, { status: 200 });
}

const delta = (value, finish = null) => ({
	choices: [{ index: 0, delta: value, finish_reason: finish }],
});

/** Replies one scripted response per request and records the bodies. */
function scriptedFetch(responses) {
	const bodies = [];
	const fetch = vi.fn(async (url, init) => {
		bodies.push({
			url,
			...init,
			json: init.body ? JSON.parse(init.body) : null,
		});
		const next = responses.shift();
		if (next instanceof Error) throw next;
		return next;
	});
	return { fetch, bodies };
}

const userTurn = (adapter) => [adapter.userMessage(["<app_state>…", "fix it"])];

describe("OpenAI-compatible adapter", () => {
	it("converts the tools to function definitions", () => {
		expect(OPENAI_TOOLS.map((tool) => tool.function.name)).toEqual([
			"list_files",
			"read_file",
			"edit_file",
			"write_file",
			"delete_file",
			"push_changes",
			"open_pull_request",
			"get_pull_request_status",
			"merge_pull_request",
		]);
		expect(OPENAI_TOOLS[1]).toMatchObject({
			type: "function",
			function: { parameters: { type: "object", required: ["path"] } },
		});
		// Gemini rejects object schemas without properties.
		for (const tool of OPENAI_TOOLS) {
			const { parameters } = tool.function;
			expect(
				Object.keys(parameters.properties).length,
				tool.function.name,
			).toBeGreaterThan(0);
			expect(parameters.required ?? ["x"], tool.function.name).not.toEqual([]);
		}
		const status = OPENAI_TOOLS.find(
			(tool) => tool.function.name === "get_pull_request_status",
		);
		expect(status.function.parameters).toEqual({
			type: "object",
			properties: {
				reason: {
					type: "string",
					description: "Optional. Not used by the app.",
				},
			},
		});
	});

	it("streams text and runs tool calls until the model stops", async () => {
		const { fetch, bodies } = scriptedFetch([
			sseResponse([
				delta({ role: "assistant", reasoning_content: "Look first." }),
				delta({ content: "Reading " }),
				delta({ content: "a.js." }),
				delta({
					tool_calls: [
						{
							index: 0,
							id: "call_a",
							type: "function",
							function: { name: "read_file", arguments: '{"pa' },
						},
					],
				}),
				delta({
					tool_calls: [{ index: 0, function: { arguments: 'th":"a.js"}' } }],
				}),
				delta({
					tool_calls: [
						{
							index: 1,
							id: "call_b",
							function: { name: "read_file", arguments: '{"path":"b.js"}' },
						},
					],
				}),
				delta({}, "tool_calls"),
			]),
			sseResponse([delta({ content: "Done." }), delta({}, "stop")]),
		]);
		const adapter = createOpenAICompatibleAdapter({
			baseUrl: "https://api.deepseek.com/",
			apiKey: "sk-ds",
			model: "deepseek-flash",
			fetch,
		});
		const messages = userTurn(adapter);
		const events = [];
		const executeTool = vi.fn(async (_name, input) => {
			if (input.path === "b.js")
				throw new ToolInputError("File not found: b.js");
			return "content of a";
		});

		await adapter.runTurn({
			system: "sys",
			messages,
			executeTool,
			onEvent: (event) => events.push(event),
		});

		expect(bodies[0].url).toBe("https://api.deepseek.com/chat/completions");
		expect(bodies[0].headers.Authorization).toBe("Bearer sk-ds");
		expect(bodies[0].json).toMatchObject({
			model: "deepseek-flash",
			stream: true,
			tool_choice: "auto",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "<app_state>…\n\nfix it" },
			],
		});
		expect(executeTool.mock.calls).toEqual([
			["read_file", { path: "a.js" }],
			["read_file", { path: "b.js" }],
		]);
		expect(messages.slice(1)).toEqual([
			{
				role: "assistant",
				content: "Reading a.js.",
				tool_calls: [
					{
						id: "call_a",
						type: "function",
						function: { name: "read_file", arguments: '{"path":"a.js"}' },
					},
					{
						id: "call_b",
						type: "function",
						function: { name: "read_file", arguments: '{"path":"b.js"}' },
					},
				],
				reasoning_content: "Look first.",
			},
			{ role: "tool", tool_call_id: "call_a", content: "content of a" },
			{
				role: "tool",
				tool_call_id: "call_b",
				content: "Error: File not found: b.js",
			},
			{ role: "assistant", content: "Done." },
		]);
		// System prompt, user, assistant and both tool results.
		expect(bodies[1].json.messages).toHaveLength(5);
		expect(
			events
				.filter((e) => e.type === "text")
				.map((e) => e.delta)
				.join(""),
		).toBe("Reading a.js.Done.");
		expect(events.find((e) => e.type === "thinking").delta).toBe("Look first.");
	});

	it.each([
		["numbers every call 0", (call) => ({ index: 0, ...call })],
		["leaves the index out", (call) => call],
	])("keeps parallel tool calls apart when an API %s", async (_name, shape) => {
		const { fetch, bodies } = scriptedFetch([
			sseResponse([
				delta({
					tool_calls: [
						shape({
							id: "call_a",
							function: { name: "read_file", arguments: '{"path"' },
						}),
					],
				}),
				delta({ tool_calls: [shape({ function: { arguments: ':"a.js"}' } })] }),
				delta({
					tool_calls: [
						shape({
							id: "call_b",
							function: { name: "list_files", arguments: "{}" },
						}),
					],
				}),
				delta({}, "tool_calls"),
			]),
			sseResponse([delta({ content: "Done." }), delta({}, "stop")]),
		]);
		const adapter = createOpenAICompatibleAdapter({
			baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
			apiKey: "key",
			model: "m",
			fetch,
		});
		const executeTool = vi.fn(async () => "ok");

		await adapter.runTurn({
			system: "sys",
			messages: userTurn(adapter),
			executeTool,
		});

		expect(executeTool.mock.calls).toEqual([
			["read_file", { path: "a.js" }],
			["list_files", {}],
		]);
		expect(bodies[1].json.messages.slice(3).map((m) => m.tool_call_id)).toEqual(
			["call_a", "call_b"],
		);
	});

	it("does not echo OpenRouter-style reasoning back as reasoning_content", async () => {
		const { fetch } = scriptedFetch([
			sseResponse([
				delta({ reasoning: "thinking..." }),
				delta({
					tool_calls: [
						{
							index: 0,
							id: "c1",
							function: { name: "list_files", arguments: "{}" },
						},
					],
				}),
				delta({}, "tool_calls"),
			]),
			sseResponse([delta({ content: "ok" }, "stop")]),
		]);
		const adapter = createOpenAICompatibleAdapter({
			baseUrl: "https://openrouter.ai/api/v1",
			apiKey: "k",
			model: "m",
			fetch,
		});
		const messages = userTurn(adapter);
		const events = [];
		await adapter.runTurn({
			system: "s",
			messages,
			executeTool: async () => "a.js",
			onEvent: (e) => events.push(e),
		});
		expect(messages[1]).not.toHaveProperty("reasoning_content");
		expect(events[0]).toEqual({ type: "thinking", delta: "thinking..." });
	});

	it("answers unparsable tool arguments with an error instead of running them", async () => {
		const { fetch } = scriptedFetch([
			sseResponse([
				delta({
					tool_calls: [
						{
							index: 0,
							id: "c1",
							function: { name: "write_file", arguments: "{bad" },
						},
					],
				}),
				delta({}, "tool_calls"),
			]),
			sseResponse([delta({ content: "Retrying." }, "stop")]),
		]);
		const adapter = createOpenAICompatibleAdapter({
			baseUrl: "https://x.test/v1",
			apiKey: "k",
			model: "m",
			fetch,
		});
		const messages = userTurn(adapter);
		const executeTool = vi.fn();
		await adapter.runTurn({ system: "s", messages, executeTool });

		expect(executeTool).not.toHaveBeenCalled();
		expect(messages[2]).toEqual({
			role: "tool",
			tool_call_id: "c1",
			content:
				"Error: INVALID_JSON: the arguments for write_file were not valid JSON.",
		});
	});

	it("never runs tool calls cut off by the length limit", async () => {
		const { fetch } = scriptedFetch([
			sseResponse([
				delta({
					tool_calls: [
						{
							index: 0,
							id: "c1",
							function: {
								name: "write_file",
								arguments: '{"path":"a.js","content":"x',
							},
						},
					],
				}),
				delta({}, "length"),
			]),
		]);
		const adapter = createOpenAICompatibleAdapter({
			baseUrl: "https://x.test/v1",
			apiKey: "k",
			model: "m",
			fetch,
		});
		const messages = userTurn(adapter);
		const events = [];
		const executeTool = vi.fn();
		await adapter.runTurn({
			system: "s",
			messages,
			executeTool,
			onEvent: (e) => events.push(e),
		});
		expect(executeTool).not.toHaveBeenCalled();
		expect(messages).toHaveLength(1);
		expect(events.at(-1)).toEqual({ type: "truncated" });
	});

	it("reports API errors with the provider's message", async () => {
		const { fetch } = scriptedFetch([
			new Response(JSON.stringify({ error: { message: "Model Not Exist" } }), {
				status: 400,
			}),
		]);
		const adapter = createOpenAICompatibleAdapter({
			baseUrl: "https://x.test/v1",
			apiKey: "k",
			model: "nope",
			fetch,
		});
		const error = await adapter
			.runTurn({
				system: "s",
				messages: userTurn(adapter),
				executeTool: vi.fn(),
			})
			.catch((e) => e);
		expect(error).toBeInstanceOf(ProviderError);
		expect(error.status).toBe(400);
		expect(error.message).toBe("400: Model Not Exist");
	});

	it("reads error messages in every provider's format", async () => {
		for (const [body, expected] of [
			[{ error: { message: "Model Not Exist" } }, "400: Model Not Exist"],
			[{ message: "Bad key" }, "400: Bad key"],
			[{ error: "quota" }, "400: quota"],
			// Gemini wraps the error in an array.
			[
				[{ error: { code: 400, message: "Please pass a valid API key" } }],
				"400: Please pass a valid API key",
			],
		]) {
			const { fetch } = scriptedFetch([
				new Response(JSON.stringify(body), { status: 400 }),
			]);
			const adapter = createOpenAICompatibleAdapter({
				baseUrl: "https://x.test/v1",
				apiKey: "k",
				model: "m",
				fetch,
			});
			await expect(adapter.listModels()).rejects.toThrow(expected);
		}
	});

	it("falls back to native HTTP without streaming when fetch is blocked", async () => {
		const { fetch } = scriptedFetch([new TypeError("Failed to fetch")]);
		const nativePost = vi.fn(async () =>
			JSON.stringify({
				choices: [
					{
						message: {
							role: "assistant",
							content: "Hello from native.",
						},
						finish_reason: "stop",
					},
				],
			}),
		);
		const adapter = createOpenAICompatibleAdapter({
			baseUrl: "https://x.test/v1",
			apiKey: "k",
			model: "m",
			fetch,
			nativePost,
		});
		const messages = userTurn(adapter);
		const events = [];
		await adapter.runTurn({
			system: "s",
			messages,
			executeTool: vi.fn(),
			onEvent: (e) => events.push(e),
		});
		await adapter.runTurn({ system: "s", messages, executeTool: vi.fn() });

		const [url, headers, body] = nativePost.mock.calls[0];
		expect(url).toBe("https://x.test/v1/chat/completions");
		expect(headers.Authorization).toBe("Bearer k");
		expect(JSON.parse(body).stream).toBe(false);
		expect(events[0]).toEqual({ type: "text", delta: "Hello from native." });
		// Once blocked, later requests go straight to native HTTP.
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(nativePost).toHaveBeenCalledTimes(2);
	});

	it("does not fall back when the user aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const nativePost = vi.fn();
		const adapter = createOpenAICompatibleAdapter({
			baseUrl: "https://x.test/v1",
			apiKey: "k",
			model: "m",
			fetch: vi.fn(),
			nativePost,
		});
		await expect(
			adapter.runTurn({
				system: "s",
				messages: userTurn(adapter),
				executeTool: vi.fn(),
				signal: controller.signal,
			}),
		).rejects.toThrow();
		expect(nativePost).not.toHaveBeenCalled();
	});

	it("lists chat models, hiding embeddings and the like", async () => {
		const { fetch } = scriptedFetch([
			new Response(
				JSON.stringify({
					data: [
						{ id: "models/gemini-pro-x" },
						{ id: "text-embedding-4" },
						{ id: "gpt-coder" },
						{ id: "tts-2" },
					],
				}),
			),
		]);
		const adapter = createOpenAICompatibleAdapter({
			baseUrl: "https://x.test/v1",
			apiKey: "k",
			model: "m",
			fetch,
		});
		await expect(adapter.listModels()).resolves.toEqual([
			"gemini-pro-x",
			"gpt-coder",
		]);
	});

	it("reads bare-array model lists and keeps only tool-capable chat models", async () => {
		const list = async (body) => {
			const { fetch } = scriptedFetch([new Response(JSON.stringify(body))]);
			const adapter = createOpenAICompatibleAdapter({
				baseUrl: "https://x.test/v1",
				apiKey: "k",
				model: "m",
				fetch,
			});
			return adapter.listModels();
		};

		// Together AI
		await expect(
			list([
				{ id: "Qwen/Qwen3-Coder", type: "chat" },
				{ id: "meta-llama/Llama-Base", type: "language" },
				{ id: "BAAI/bge-large", type: "embedding" },
				{ id: "black-forest-labs/FLUX", type: "image" },
			]),
		).resolves.toEqual(["Qwen/Qwen3-Coder"]);
		// Mistral's "type" says how the model was made, not what it does.
		await expect(
			list({ data: [{ id: "mistral-large-latest", type: "base" }] }),
		).resolves.toEqual(["mistral-large-latest"]);
		// Hugging Face lists the providers serving each model.
		await expect(
			list({
				data: [
					{
						id: "openai/gpt-oss-120b",
						providers: [
							{ provider: "a", supports_tools: false },
							{ provider: "b", supports_tools: true },
						],
					},
					{
						id: "some/chat-only",
						providers: [{ provider: "a", supports_tools: false }],
					},
				],
			}),
		).resolves.toEqual(["openai/gpt-oss-120b"]);
	});

	it("sends no Authorization header without a key (local model servers)", async () => {
		const { fetch, bodies } = scriptedFetch([
			new Response(JSON.stringify({ data: [{ id: "qwen3:8b" }] })),
			sseResponse([delta({ content: "Hi." }), delta({}, "stop")]),
		]);
		const adapter = createOpenAICompatibleAdapter({
			baseUrl: "http://localhost:11434/v1",
			apiKey: "",
			model: "qwen3:8b",
			fetch,
		});

		await expect(adapter.listModels()).resolves.toEqual(["qwen3:8b"]);
		await adapter.runTurn({
			system: "s",
			messages: userTurn(adapter),
			executeTool: vi.fn(),
		});

		expect(bodies.map((body) => body.url)).toEqual([
			"http://localhost:11434/v1/models",
			"http://localhost:11434/v1/chat/completions",
		]);
		for (const body of bodies) {
			expect(body.headers).not.toHaveProperty("Authorization");
		}
	});

	it("keeps streaming after a dropped connection, and skips fetch only once native works", async () => {
		const dropped = new TypeError("Failed to fetch");
		const fetch = vi
			.fn()
			.mockRejectedValueOnce(dropped)
			.mockResolvedValueOnce(
				sseResponse([delta({ content: "Streamed." }), delta({}, "stop")]),
			)
			.mockRejectedValue(dropped);
		const nativePost = vi
			.fn()
			.mockRejectedValueOnce(
				Object.assign(new Error("Software caused connection abort"), {
					network: true,
				}),
			)
			.mockResolvedValue(
				JSON.stringify({
					choices: [{ message: { content: "Native." }, finish_reason: "stop" }],
				}),
			);
		const adapter = createOpenAICompatibleAdapter({
			baseUrl: "https://x.test/v1",
			apiKey: "k",
			model: "m",
			fetch,
			nativePost,
		});
		const turn = () =>
			adapter.runTurn({
				system: "s",
				messages: userTurn(adapter),
				executeTool: vi.fn(),
			});

		// fetch and the native request both fail: the network dropped.
		await expect(turn()).rejects.toThrow("Software caused connection abort");
		// So the next request streams through fetch again.
		await turn();
		expect(fetch).toHaveBeenCalledTimes(2);
		// fetch fails but native works: fetch is blocked, so it is skipped
		// from then on.
		await turn();
		await turn();
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(nativePost).toHaveBeenCalledTimes(3);
	});

	it("names the server it could not connect to", async () => {
		const refused = new TypeError("fetch failed", {
			cause: Object.assign(new Error("connect ECONNREFUSED"), {
				code: "ECONNREFUSED",
			}),
		});
		const adapter = createOpenAICompatibleAdapter({
			baseUrl: "http://localhost:11434/v1",
			model: "m",
			fetch: vi.fn(async () => {
				throw refused;
			}),
		});
		const expected = "Could not connect to localhost:11434 (ECONNREFUSED).";
		await expect(adapter.listModels()).rejects.toThrow(expected);
		await expect(
			adapter.runTurn({
				system: "s",
				messages: userTurn(adapter),
				executeTool: vi.fn(),
			}),
		).rejects.toThrow(expected);
	});

	it("lists models through native HTTP when fetch is blocked", async () => {
		const nativeGet = vi.fn(async () =>
			JSON.stringify({ data: [{ id: "kimi" }] }),
		);
		const adapter = createOpenAICompatibleAdapter({
			baseUrl: "https://x.test/v1",
			apiKey: "k",
			model: "m",
			fetch: vi.fn(async () => {
				throw new TypeError("Failed to fetch");
			}),
			nativeGet,
		});
		await expect(adapter.listModels()).resolves.toEqual(["kimi"]);
		expect(nativeGet).toHaveBeenCalledWith("https://x.test/v1/models", {
			Authorization: "Bearer k",
		});
	});
});
