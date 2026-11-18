import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // dist/ holds compiled output of the same test files. Running them too
    // double-counts the suite and lets stale build artifacts report as passing.
    exclude: ["**/node_modules/**", "dist/**", ".cleanup-backup-*/**"],
  },
});
