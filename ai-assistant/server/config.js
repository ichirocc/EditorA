import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_SETTINGS = {
	provider: "anthropic",
	model: "claude-opus-5-5",
	baseUrl: "",
	owner: "",
	repo: "",
	baseBranch: "main",
};

/**
 * Settings, API keys and the access token, kept in one JSON file that only
 * the user can read (mode 0600, in a 0700 directory).
 *
 * A secret named `github_token` or `ai_key_deepseek` can also come from the
 * environment variable `GITHUB_TOKEN` or `AI_KEY_DEEPSEEK`, which wins over
 * the file. `ASSISTANT_TOKEN` likewise sets the access token.
 *
 * @param {object} [options]
 * @param {string} [options.dir] defaults to $ASSISTANT_HOME or ~/.editora-ai-assistant
 * @param {Record<string, string|undefined>} [options.env]
 */
export function createConfigStore({
	env = process.env,
	dir = env.ASSISTANT_HOME || path.join(homedir(), ".editora-ai-assistant"),
} = {}) {
	const file = path.join(dir, "config.json");
	/**@type {{settings:typeof DEFAULT_SETTINGS, secrets:Record<string,string>, accessToken?:string}|null} */
	let data = null;

	async function load() {
		if (data) return data;
		let stored = {};
		try {
			stored = JSON.parse(await readFile(file, "utf8"));
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		data = {
			...stored,
			settings: { ...DEFAULT_SETTINGS, ...stored.settings },
			secrets: { ...stored.secrets },
		};
		return data;
	}

	async function save() {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(file, `${JSON.stringify(data, null, "\t")}\n`, {
			mode: 0o600,
		});
		// writeFile only applies the mode when it creates the file.
		await chmod(file, 0o600);
	}

	return {
		file,

		/** @returns {Promise<typeof DEFAULT_SETTINGS>} */
		async settings() {
			return { ...(await load()).settings };
		},

		/**
		 * @param {string} name e.g. "github_token", "ai_key_deepseek"
		 * @returns {Promise<string>} empty when not set
		 */
		async secret(name) {
			return env[name.toUpperCase()] || (await load()).secrets[name] || "";
		},

		/**
		 * Whether a secret is set, without revealing it.
		 * @param {string} name
		 */
		async hasSecret(name) {
			return !!(await this.secret(name));
		},

		/**
		 * @param {object} changes
		 * @param {Partial<typeof DEFAULT_SETTINGS>} [changes.settings]
		 * @param {Record<string, string>} [changes.secrets] empty values are ignored
		 */
		async update({ settings = {}, secrets = {} }) {
			await load();
			Object.assign(data.settings, settings);
			for (const [name, value] of Object.entries(secrets)) {
				if (value) data.secrets[name] = value;
			}
			await save();
		},

		/**
		 * The token the web UI must send. Created on first use.
		 * @returns {Promise<string>}
		 */
		async accessToken() {
			if (env.ASSISTANT_TOKEN) return env.ASSISTANT_TOKEN;
			await load();
			if (!data.accessToken) {
				data.accessToken = randomBytes(24).toString("base64url");
				await save();
			}
			return data.accessToken;
		},
	};
}

/**@typedef {ReturnType<typeof createConfigStore>} ConfigStore */
