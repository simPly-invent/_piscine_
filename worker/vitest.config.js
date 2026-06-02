import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run tests from the project root so imports resolve correctly
    root: "..",
    include: ["tests/**/*.test.js"],
    environment: "node",
    globals: false,
  },
});
