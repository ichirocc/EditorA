#!/usr/bin/env node
/**
 * Live check of the AI providers: for every provider whose API key is set,
 * load its model list, then run two real turns of the assistant's tool loop
 * on a small in-memory repository (no GitHub access needed):
 *
 *   1. "change 41 to 42 in hello.js"   - the model must call a tool to edit
 *   2. "add a comment above that line" - the provider must accept the
 *                                        conversation so far, including the
 *                                        previous tool calls and results
 *
 * Keys use the same names as the server: ANTHROPIC_API_KEY, AI_KEY_DEEPSEEK,
 * AI_KEY_OPENAI, AI_KEY_GEMINI, AI_KEY_XAI, AI_KEY_MOONSHOT, AI_KEY_QWEN,
 * AI_KEY_ZAI, AI_KEY_MISTRAL, AI_KEY_OPENROUTER, AI_KEY_HUGGINGFACE,
 * AI_KEY_GROQ, AI_KEY_TOGETHER, AI_KEY_FIREWORKS, AI_KEY_CUSTOM.
 * Model servers on this device (Ollama, LM Studio, llama.cpp) need no key:
 * select them with --only or AI_MODEL_<PROVIDER>, e.g.
 *   npm run check:providers -- --only ollama
 * Pick a model with AI_MODEL_<PROVIDER> (required where the provider has no
 * default; the output lists the available ones). AI_BASE_URL_<PROVIDER>
 * overrides the API root (required for CUSTOM).
 *
 * Usage:  npm run check:providers [-- --only deepseek,gemini] [-- --json]
 * Behind an HTTP proxy, run Node with NODE_USE_ENV_PROXY=1 (Node >= 22.21).
 * Each checked provider costs a few cents of API usage.
 */
import {
	createModelAdapter,
	PROVIDERS,
	secretNameFor,
} from "../core/providers.js";
import AssistantSession from "../core/session.js";

const TURN_TIMEOUT_MS = 3 * 60_000;
// Models on the device itself can be much slower.
const LOCAL_TURN_TIMEOUT_MS = 15 * 60_000;
const FILE = "hello.js";
const ORIGINAL = "export function answer() {\n\treturn 41;\n}\n";

const args = process.argv.slice(2);
const only = args
	.find((arg, i) => args[i - 1] === "--only" || arg.startsWith("--only="))
	?.replace(/^--only=/, "")
	.split(",");
const asJson = args.includes("--json");

/** A one-file repository that the session reads instead of GitHub. */
function memoryRepo() {
	return {
		getBranchHead: async () => ({ commitSha: "c0", treeSha: "t0" }),
		listFiles: async () => ({
			files: [{ path: FILE, mode: "100644", size: ORIGINAL.length }],
			truncated: false,
		}),
		readFile: async (_owner, _repo, path) => (path === FILE ? ORIGINAL : null),
	};
}

/**
 * @param {import("../core/providers.js").Provider} provider
 */
async function checkProvider(provider) {
	const id = provider.id.toUpperCase();
	const result = {
		provider: provider.label,
		model: "",
		models: null,
		turn1: false,
		turn2: false,
		streamed: false,
		reasoning: false,
		tools: [],
		fallbacks: [],
		seconds: 0,
		error: "",
	};
	const apiKey = process.env[secretNameFor(provider).toUpperCase()] || "";
	const selected =
		only?.includes(provider.id) || !!process.env[`AI_MODEL_${id}`];
	if (!apiKey && !(provider.keyOptional && selected)) {
		return {
			...result,
			skipped: provider.keyOptional ? `use --only ${provider.id}` : "no key",
		};
	}
	const baseUrl = process.env[`AI_BASE_URL_${id}`] || provider.baseUrl;
	if (provider.kind === "openai" && !baseUrl) {
		return { ...result, skipped: `set AI_BASE_URL_${id}` };
	}

	const started = Date.now();
	try {
		const lister = await createModelAdapter({
			provider,
			model: "",
			baseUrl,
			apiKey,
		});
		const models = await lister.listModels();
		result.models = models.length;
		result.model = process.env[`AI_MODEL_${id}`] || provider.defaultModel || "";
		if (!result.model) {
			throw new Error(
				`set AI_MODEL_${id} to one of: ${models.slice(0, 15).join(", ")}${models.length > 15 ? ", …" : ""}`,
			);
		}

		const ai = await createModelAdapter({
			provider,
			model: result.model,
			baseUrl,
			apiKey,
		});
		const session = new AssistantSession({
			github: memoryRepo(),
			ai,
			owner: "example",
			repo: "check",
			baseBranch: "main",
		});
		await session.start();
		let refused = false;
		const onEvent = (event) => {
			if (event.type === "text") result.streamed = true;
			if (event.type === "thinking") result.reasoning = true;
			if (event.type === "tool") {
				result.tools.push(`${event.name}${event.isError ? "!" : ""}`);
			}
			if (event.type === "refusal") refused = true;
			if (event.type === "fallback") {
				result.fallbacks.push(`${event.from} -> ${event.to}`);
			}
		};
		const turn = (text) =>
			session.send(text, {
				onEvent,
				signal: AbortSignal.timeout(
					provider.group === "local" ? LOCAL_TURN_TIMEOUT_MS : TURN_TIMEOUT_MS,
				),
			});

		await turn(
			`In ${FILE}, change the return value from 41 to 42. Make the edit with your tools now; do not ask for confirmation.`,
		);
		if (refused) throw new Error("the model refused");
		const first = session.changeSet.get(FILE)?.content || "";
		result.turn1 = first.includes("return 42;") && !first.includes("41");
		if (!result.turn1)
			throw new Error(
				`turn 1 did not stage the edit: ${JSON.stringify(first)}`,
			);

		await turn(
			"Now add the line `// The answer.` directly above the return statement, with the same indentation. Use your tools.",
		);
		if (refused) throw new Error("the model refused");
		const second = session.changeSet.get(FILE)?.content || "";
		result.turn2 =
			second.includes("// The answer.") && second.includes("return 42;");
		if (!result.turn2)
			throw new Error(
				`turn 2 did not stage the edit: ${JSON.stringify(second)}`,
			);
	} catch (error) {
		result.error = String(error?.message || error).slice(0, 300);
	}
	result.seconds = Math.round((Date.now() - started) / 100) / 10;
	return result;
}

const providers = PROVIDERS.filter(
	(provider) => !only || only.includes(provider.id),
);
const results = [];
for (const provider of providers) {
	const result = await checkProvider(provider);
	results.push(result);
	if (!asJson) {
		const status = result.skipped
			? `skipped (${result.skipped})`
			: result.turn1 && result.turn2
				? "OK"
				: "FAILED";
		console.log(
			`${status.padEnd(16)} ${result.provider}${result.model ? ` / ${result.model}` : ""}`,
		);
		if (!result.skipped) {
			console.log(
				`                 models: ${result.models ?? "-"}, tool edit: ${result.turn1 ? "yes" : "no"}, follow-up: ${result.turn2 ? "yes" : "no"}, streamed: ${result.streamed ? "yes" : "no"}, reasoning: ${result.reasoning ? "yes" : "no"}, tools: ${result.tools.join(" ") || "-"}, ${result.seconds}s`,
			);
			if (result.fallbacks.length) {
				console.log(
					`                 answered instead: ${result.fallbacks.join(", ")}`,
				);
			}
			if (result.error) console.log(`                 error: ${result.error}`);
		}
	}
}
if (asJson) console.log(JSON.stringify(results, null, 2));

const checked = results.filter((result) => !result.skipped);
if (!checked.length && !asJson) {
	console.log(
		"\nNo provider was checked: set at least one key (see the top of this file).",
	);
}
process.exitCode = checked.some((result) => !(result.turn1 && result.turn2))
	? 1
	: 0;
