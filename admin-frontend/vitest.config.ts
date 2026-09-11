import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    // Coverage, for the same reason the main console produces it: without a
    // report SonarQube reads this app as 0% covered, which is what an app with
    // no tests at all looks like — and it is this half of the repo that then
    // drags the gate's new-code coverage down.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      reportsDirectory: "./coverage",
      // `all`, so files no test reaches are counted. Measuring only the files a
      // test already imports produces a number that cannot go down.
      all: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test/**", "src/app/**", "src/**/*.d.ts"],
    },
  },
});
