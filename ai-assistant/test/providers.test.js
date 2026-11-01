import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createModelAdapter,
	DEFAULT_PROVIDER_ID,
	getProvider,
	isAllowedBaseUrl,
	PROVIDERS,
	secretNameFor,
} from "../core/providers.js";

describe("AI assistant providers", () => {
	it("offers Claude, DeepSeek and the other compatible providers", () => {
		expect(PROVIDERS.map((provider) => provider.id)).toEqual([
			"anthropic",
			"deepseek",
			"openai",
			"gemini",
			"xai",
			"moonshot",
			"qwen",
			"zai",
			"mistral",
			"openrouter",
			"huggingface",
			"groq",
			"together",
			"fireworks",
			"ollama",
			"lmstudio",
			"llamacpp",
			"custom",
		]);
		for (const provider of PROVIDERS) {
			if (provider.kind === "anthropic") continue;
			expect(provider.kind).toBe("openai");
			if (provider.id !== "custom") {
				expect(isAllowedBaseUrl(provider.baseUrl)).toBe(true);
			}
		}
	});

	it("groups the providers, and runs local model servers without a key", () => {
		const groups = [...new Set(PROVIDERS.map((provider) => provider.group))];
		// Members of a group are listed together.
		expect(groups).toEqual(["vendor", "hosted", "local", "other"]);
		for (const provider of PROVIDERS) {
			const local = provider.group === "local";
			expect(!!provider.keyOptional).toBe(local || provider.id === "custom");
			if (local)
				expect(provider.baseUrl).toMatch(/^http:\/\/localhost:\d+\/v1$/);
		}
	});

	it("starts with Gemini, which has a free tier, also for an unknown id", () => {
		expect(DEFAULT_PROVIDER_ID).toBe("gemini");
		expect(getProvider("gemini").defaultModel).toBe("gemini-3.5-flash");
		expect(getProvider("deepseek").label).toBe("DeepSeek");
		expect(getProvider("gone").id).toBe("gemini");
	});

	it("names each provider's key for the native allow-list", () => {
		expect(secretNameFor(getProvider("anthropic"))).toBe("anthropic_api_key");
		for (const provider of PROVIDERS.slice(1)) {
			// Must match ai_key_[a-z0-9_]{1,32} in Authenticator.java.
			expect(secretNameFor(provider)).toMatch(/^ai_key_[a-z0-9_]{1,32}$/);
		}
	});

	describe("adapters", () => {
		afterEach(() => vi.unstubAllGlobals());
		const reply = (content) =>
			JSON.stringify({
				choices: [
					{ message: { role: "assistant", content }, finish_reason: "stop" },
				],
			});
		const turn = (adapter) =>
			adapter.runTurn({
				system: "s",
				messages: [adapter.userMessage(["hi"])],
				executeTool: vi.fn(),
			});

		it("let Gemini's fast models answer when the chosen one cannot", async () => {
			const models = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url, init) => {
					const { model } = JSON.parse(init.body);
					models.push(model);
					return model === "gemini-3.1-pro-preview"
						? new Response('{"error":{"message":"quota"}}', { status: 429 })
						: new Response(
								`data: ${JSON.stringify({ choices: [{ delta: { content: "Hi." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
							);
				}),
			);
			const adapter = await createModelAdapter({
				provider: getProvider("gemini"),
				model: "gemini-3.1-pro-preview",
				apiKey: "k",
			});
			await turn(adapter);
			expect(models).toEqual(["gemini-3.1-pro-preview", "gemini-3.5-flash"]);
		});

		it("turn Qwen's thinking off where requests do not stream", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					throw new TypeError("Failed to fetch");
				}),
			);
			const nativePost = vi.fn(async () => reply("Hi."));
			const adapter = await createModelAdapter({
				provider: getProvider("qwen"),
				model: "qwen3-32b",
				apiKey: "k",
				nativePost,
			});
			await turn(adapter);
			expect(JSON.parse(nativePost.mock.calls[0][2]).enable_thinking).toBe(
				false,
			);
		});
	});

	it("only allows HTTPS, or HTTP to the device itself", () => {
		expect(isAllowedBaseUrl("https://api.deepseek.com")).toBe(true);
		expect(isAllowedBaseUrl("http://localhost:11434/v1")).toBe(true);
		expect(isAllowedBaseUrl("http://127.0.0.1:1234/v1")).toBe(true);
		expect(isAllowedBaseUrl("http://192.168.1.5:11434/v1")).toBe(false);
		expect(isAllowedBaseUrl("http://localhost.evil.test/v1")).toBe(false);
		expect(isAllowedBaseUrl("ftp://x")).toBe(false);
		expect(isAllowedBaseUrl("")).toBe(false);
	});
});
