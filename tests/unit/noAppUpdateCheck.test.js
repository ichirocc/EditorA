import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// This fork is built from its own repository; upstream Acode releases are not
// its updates, so the app must neither ask to check them nor check them.
test("the app never checks upstream Acode releases for updates", () => {
	const main = read("src/main.js");
	expect(main).not.toMatch(/Acode-Foundation\/Acode\/releases/);
	expect(main).not.toMatch(/promptUpdateCheckConsent|checkForUpdatesPrompted/);

	for (const file of [
		"src/main.js",
		"src/settings/appSettings.js",
		"src/lib/settings.js",
	]) {
		expect(read(file), file).not.toMatch(/checkForAppUpdates/);
	}
});
