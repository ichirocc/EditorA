/**
 * API credentials for the AI assistant, kept in Android's encrypted shared
 * preferences by the Authenticator plugin. They are never written to the
 * settings file, so they stay out of settings backups.
 */

/**@typedef {"anthropic_api_key"|"github_token"} SecretName */

/**
 * @param {string} action
 * @param {any[]} args
 * @returns {Promise<any>}
 */
function exec(action, args) {
	return new Promise((resolve, reject) => {
		if (!window.cordova?.exec) {
			reject(new Error("Secure storage is unavailable."));
			return;
		}
		cordova.exec(
			resolve,
			(error) => reject(new Error(error || "Secure storage failed.")),
			"Authenticator",
			action,
			args,
		);
	});
}

export default {
	/**
	 * @param {SecretName} name
	 * @returns {Promise<string>} empty string when not set
	 */
	async get(name) {
		return (await exec("getSecret", [name])) || "";
	},

	/**
	 * @param {SecretName} name
	 * @param {string} value
	 */
	set(name, value) {
		return exec("setSecret", [name, value]);
	},

	/**
	 * @param {SecretName} name
	 */
	remove(name) {
		return exec("removeSecret", [name]);
	},
};
