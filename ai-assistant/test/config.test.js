import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfigStore } from "../server/config.js";

let dir;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "assistant-config-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("assistant config store", () => {
	it("starts with Gemini defaults and nothing saved", async () => {
		const store = createConfigStore({ dir, env: {} });
		expect(await store.settings()).toEqual({
			provider: "gemini",
			model: "gemini-3.5-flash",
			baseUrl: "",
			owner: "ichirocc",
			repo: "EditorA",
			baseBranch: "main",
		});
		expect(await store.hasSecret("github_token")).toBe(false);
	});

	it("persists settings and secrets in a file only the user can read", async () => {
		const store = createConfigStore({ dir, env: {} });
		await store.update({
			settings: { owner: "me" },
			secrets: { github_token: "ghp", ai_key_deepseek: "" },
		});
		const again = createConfigStore({ dir: path.join(dir), env: {} });
		expect((await again.settings()).owner).toBe("me");
		expect(await again.secret("github_token")).toBe("ghp");
		// Empty values do not overwrite or create secrets.
		expect(await again.hasSecret("ai_key_deepseek")).toBe(false);
		expect((await stat(store.file)).mode & 0o777).toBe(0o600);
		expect((await stat(dir)).mode & 0o077).toBe(0);
	});

	it("lets environment variables override stored secrets", async () => {
		const store = createConfigStore({
			dir,
			env: { GITHUB_TOKEN: "from-env", AI_KEY_DEEPSEEK: "ds-env" },
		});
		await store.update({ secrets: { github_token: "from-file" } });
		expect(await store.secret("github_token")).toBe("from-env");
		expect(await store.secret("ai_key_deepseek")).toBe("ds-env");
	});

	it("creates one access token and keeps it", async () => {
		const store = createConfigStore({ dir, env: {} });
		const token = await store.accessToken();
		expect(token).toMatch(/^[\w-]{32}$/);
		expect(await createConfigStore({ dir, env: {} }).accessToken()).toBe(token);
		expect(
			await createConfigStore({
				dir,
				env: { ASSISTANT_TOKEN: "set" },
			}).accessToken(),
		).toBe("set");
	});
});
