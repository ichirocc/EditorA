import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("lib/config", () => ({ default: { HAS_PRO: false } }));
vi.mock("lib/startAd", () => ({
	default: vi.fn(),
	ADS_ENABLED: false,
	adUnitIdRewarded: "test-unit",
	initialized: false,
	getPrivacyState: () => ({ canRequestAds: true }),
}));

let showRewardedAd;
let isRewardedAdSupported;
let constructed;

beforeEach(async () => {
	vi.resetModules();
	constructed = 0;
	vi.stubGlobal("window", { ANDROID_SDK_INT: 36 });
	vi.stubGlobal("strings", {
		"rewarded ad unavailable": "Unavailable",
		"rewarded ad failed": "Failed",
	});
	vi.stubGlobal("admob", {
		RewardedAd: class {
			constructor() {
				constructed += 1;
			}
		},
	});
	({ default: showRewardedAd, isRewardedAdSupported } = await import(
		"lib/rewardedAd"
	));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ads disabled policy", () => {
	it("does not support or construct a rewarded ad", async () => {
		expect(isRewardedAdSupported()).toBe(false);
		await expect(showRewardedAd()).resolves.toBe(false);
		expect(constructed).toBe(0);
	});
});
