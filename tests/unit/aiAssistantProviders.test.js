import {
	getProvider,
	isAllowedBaseUrl,
	PROVIDERS,
	secretNameFor,
} from "lib/aiAssistant/providers";
import { describe, expect, it } from "vitest";

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

	it("falls back to Claude for an unknown id", () => {
		expect(getProvider("deepseek").label).toBe("DeepSeek");
		expect(getProvider("gone").id).toBe("anthropic");
	});

	it("names each provider's key for the native allow-list", () => {
		expect(secretNameFor(getProvider("anthropic"))).toBe("anthropic_api_key");
		for (const provider of PROVIDERS.slice(1)) {
			// Must match ai_key_[a-z0-9_]{1,32} in Authenticator.java.
			expect(secretNameFor(provider)).toMatch(/^ai_key_[a-z0-9_]{1,32}$/);
		}
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
