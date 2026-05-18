import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	resolve: {
		alias: {
			// `obsidian` ships only typings; its package.json `main` is empty. Tests
			// that exercise code with a runtime `import { requestUrl } from "obsidian"`
			// need a stub. vi.mock("obsidian", …) can still override exports per-test.
			obsidian: fileURLToPath(new URL("./tests/obsidian-stub.ts", import.meta.url)),
		},
	},
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
	},
});
