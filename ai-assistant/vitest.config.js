import { defineConfig } from "vitest/config";

// Keeps `npm test` here independent of the editor's config one folder up.
export default defineConfig({
	test: {
		include: ["test/**/*.test.js"],
	},
});
