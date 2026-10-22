const fs = require("node:fs");
const path = require("node:path");

/**
 * Source-level guards that must hold for the ads-disabled security build.
 * Each entry names a file and the patterns that prove its ad gate is closed.
 */
const REQUIRED_GUARDS = [
	{
		file: "src/lib/startAd.js",
		patterns: [
			{
				pattern: /^export const ADS_ENABLED = false;/m,
				message: "ADS_ENABLED must be exported as `false` on its own line.",
			},
			{
				pattern: /^export let initialized = false;/m,
				message: "`initialized` must be declared on its own line.",
			},
			{
				pattern: /function canUseAdmob\(\) \{\s*return \(\s*ADS_ENABLED &&/,
				message: "canUseAdmob() must require ADS_ENABLED.",
			},
			{
				pattern:
					/async function initializeAds\(\) \{\s*if \(!ADS_ENABLED \|\| initialized\) return;/,
				message: "initializeAds() must return early when ADS_ENABLED is false.",
			},
		],
	},
	{
		file: "src/utils/helpers.js",
		patterns: [
			{
				pattern: /canShowAds\(\) \{\s*if \(!ADS_ENABLED\) return false;/,
				message: "canShowAds() must return false when ADS_ENABLED is false.",
			},
		],
	},
	{
		file: "src/lib/rewardedAd.js",
		patterns: [
			{
				pattern:
					/function isRewardedAdSupported\(\) \{\s*return Boolean\(\s*ADS_ENABLED &&/,
				message: "isRewardedAdSupported() must require ADS_ENABLED.",
			},
			{
				pattern:
					/\} = \{\}\) \{\s*if \(!ADS_ENABLED\) return Promise\.resolve\(false\);/,
				message:
					"showRewardedAd() must resolve false when ADS_ENABLED is false.",
			},
		],
	},
];

const FORBIDDEN_PATTERNS = [
	{
		file: "src/lib/startAd.js",
		pattern: /ADS_ENABLED = true/,
		message: "ADS_ENABLED must not be set to true.",
	},
	{
		file: "utils/config.js",
		pattern: /["']plugin["'],\s*["']add["'],\s*["']src\/plugins\/admob["']/,
		message: "Build configuration must not install the AdMob plugin.",
	},
];

/**
 * Validates that ordinary, interstitial and rewarded ads stay disabled.
 *
 * @param {{rootDir:string, fsImpl?:typeof fs}} options
 */
function validateAdsDisabled({ rootDir, fsImpl = fs }) {
	const sources = new Map();
	const read = (file) => {
		if (!sources.has(file)) {
			const filePath = path.join(rootDir, file);
			if (!fsImpl.existsSync(filePath)) {
				throw new Error(`Missing source file: ${file}`);
			}
			sources.set(file, fsImpl.readFileSync(filePath, "utf8"));
		}
		return sources.get(file);
	};

	const failures = [];
	for (const { file, patterns } of REQUIRED_GUARDS) {
		const source = read(file);
		for (const { pattern, message } of patterns) {
			if (!pattern.test(source)) failures.push(`${file}: ${message}`);
		}
	}
	for (const { file, pattern, message } of FORBIDDEN_PATTERNS) {
		if (pattern.test(read(file))) failures.push(`${file}: ${message}`);
	}

	if (failures.length) {
		throw new Error(
			`Ads-disabled policy violated:\n- ${failures.join("\n- ")}`,
		);
	}

	return { checkedFiles: [...sources.keys()] };
}

function main() {
	const rootDir = path.resolve(__dirname, "../..");
	const result = validateAdsDisabled({ rootDir });
	console.log(`Ads are disabled (checked: ${result.checkedFiles.join(", ")}).`);
}

if (require.main === module) {
	try {
		main();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}

module.exports = { validateAdsDisabled };
