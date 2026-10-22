# Acode security review and hardening notes

Scope: source-level static review of the supplied Acode source archive. This is not a penetration test, runtime traffic audit, or security certification.

## Changes applied in this package
1. Ads disabled at the central AdMob availability gate (`src/lib/startAd.js`).
2. Ordinary ad eligibility returns false (`src/utils/helpers.js`).
3. Rewarded-ad entry point returns `false` without showing an ad or granting a reward (`src/lib/rewardedAd.js`).
4. Android cleartext traffic is disabled by default (`config.xml` and `res/android/xml/network_security_config.xml`).
5. Localhost and IPv4 loopback HTTP exceptions are retained for local preview/development workflows.

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
6. Run the repository's test and typecheck commands after installing dependencies (`npm ci`, `npm test`, `npm run typecheck`). Build only after reviewing any failures.
7. Confirm ad-dependent features are handled in the UI; rewarded features intentionally do not grant rewards in this ad-disabled build.

## Not yet performed
- APK reverse engineering / final merged manifest inspection.
- Runtime packet capture and payload review.
- Full dependency CVE scan.
- Android 17 device build and UI/performance regression tests.
- Comprehensive plugin-by-plugin audit.
