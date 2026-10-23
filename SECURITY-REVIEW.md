# Acode security review and hardening notes

Scope: source-level static review of the supplied Acode source archive. This is not a penetration test, runtime traffic audit, or security certification.

## Changes applied in this package
1. Ads disabled at the central AdMob availability gate (`src/lib/startAd.js`). `ADS_ENABLED = false` gates `canUseAdmob()` and `initializeAds()`, so the SDK is never started, consent is never requested, and no banner/interstitial/rewarded unit is created. (An earlier revision of this package placed `ADS_ENABLED` and `initialized` on one line joined by a literal `\n`, which commented out the `initialized` declaration; this is fixed.)
2. Ordinary ad eligibility returns false (`helpers.canShowAds()` in `src/utils/helpers.js`), which also suppresses interstitials and page banners.
3. Rewarded-ad entry point returns `false` without showing an ad or granting a reward (`src/lib/rewardedAd.js`); `isRewardedAdSupported()` also returns false.
4. Android cleartext traffic is disabled by default (`config.xml` and `res/android/xml/network_security_config.xml`).
5. Localhost and IPv4 loopback HTTP exceptions are retained for local preview/development workflows.
6. The AdMob Cordova plugin is no longer installed for any build variant (`utils/config.js`). Free builds remove it like paid builds and no longer require `src/plugins/admob/www/admob.js`; the build fails if the plugin is still present after configuration.
7. `npm run check:ads-disabled` (`utils/scripts/checkOrdinaryAdsDisabled.js`) statically verifies the gates above and that the build configuration does not re-add the AdMob plugin. `tests/admob/adsDisabledPolicy.test.js` verifies at runtime that no rewarded ad is constructed while ads are disabled.
8. The `codemirror-lsp-client` git submodule (source of `@codemirror/lsp-client`) is registered so the app builds from a fresh `git clone --recurse-submodules`.
9. Runtime dependencies `dompurify` (3.4.14 → 3.4.17, critical advisories) and `markdown-it` (14.3.0 → 14.3.3, high-severity DoS advisories) were updated. All DOMPurify call sites use plain `sanitize()` without `IN_PLACE`, hooks or `SAFE_FOR_TEMPLATES`, so the advisories were not believed exploitable here, but the update removes them.
10. `adRewards.canShowAds()` returns false while ads are disabled, and the "earn ad-free time" settings entry is hidden. Previously a free-variant build asked for a rewarded ad before changing the app icon, the ad never ran, and the icon could not be changed.
11. `utils/scripts/build.sh` stops at the first failing step (`set -e`, no `eval`), so a failed `utils/config.js` run (including the AdMob removal check) no longer continues into rspack and `cordova build`.
12. `.github/workflows/android-apk.yml` builds an installable APK on GitHub Actions. It runs the ads-disabled check and the test suite first, then inspects the built APK's manifest and fails if AdMob is referenced or `usesCleartextTraffic` is not false.

## Findings and risk notes
- `config.xml` previously enabled `android:usesCleartextTraffic="true"`. This was a high-priority hardening target.
- `config.xml` permits broad WebView navigation to both `http://*/*` and `https://*/*`. This remains unchanged to avoid breaking Acode's code-editor/web-preview workflows. Navigation allowlists and network cleartext policy are separate controls; remote HTTP may now fail.
- `src/lib/config.js` defines `https://acode.app/api` and several external links/CDN endpoints. A URL constant by itself does not prove personal data is sent. Request call sites and payloads must be traced at runtime to determine actual transmission.
- The app includes network-capable features/plugins such as FTP, SFTP, WebSocket, browser/custom-tabs, advanced HTTP, authentication, crash-handler, and plugin-context. Their existence is not proof of malicious behavior, but their source and runtime behavior need separate review.
- FTP is not encrypted. Prefer SFTP or FTPS when available; do not send reusable credentials over untrusted networks using FTP.
- User-installed plugins and remote preview content can introduce additional network behavior outside the core app's fixed code paths.
- No claim is made that all telemetry, crash reports, external requests, or sensitive-data flows have been eliminated.

## Manual test plan (Pixel 10 Pro XL / Android 17)
1. Build a debug APK and check manifest-merging output for the final cleartext policy.
2. Test launch, local preview, file open/save, GitHub/API access, browser preview, plugin install, WebSocket, SFTP, and any required HTTP local-development flow.
3. Observe traffic with Android Studio Network Inspector or a trusted local VPN traffic analyzer. Do not share logs containing tokens, passwords, file contents, or personal data.
4. Review each destination and payload; specifically check whether files, editor contents, credentials, identifiers, diagnostics, or crash details leave the device.
5. Check dependency advisories and plugin code; this source package does not include a completed dependency vulnerability scan.
6. Run the repository's test and typecheck commands after installing dependencies (`npm ci`, `npm test`, `npm run typecheck`, `npm run check:ads-disabled`). Build only after reviewing any failures.
7. After `cordova prepare`, confirm `plugins/admob-plus-cordova` is absent and the merged manifest contains no `com.google.android.gms.ads.APPLICATION_ID` meta-data.
8. Confirm ad-dependent features are handled in the UI; rewarded features intentionally do not grant rewards in this ad-disabled build.

## Not yet performed
- APK reverse engineering / final merged manifest inspection.
- Runtime packet capture and payload review.
- Full dependency CVE remediation. `npm audit` still reports 39 advisories (0 critical, 30 high), all in build-time tooling (Cordova CLI, `@xmldom/xmldom`, `undici`, `vite`, `mocha`, `jshint` and their transitive dependencies) rather than code shipped in the APK. Several fixes need major-version upgrades of the Cordova toolchain.
- Android 17 device build and UI/performance regression tests.
- Comprehensive plugin-by-plugin audit.
