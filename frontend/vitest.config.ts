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
    // COVERAGE, so the analyser is told what the 2,000+ tests actually reach.
    //
    // Without a report SonarQube reports 0% — indistinguishable from having no
    // tests at all, and the number that fails the quality gate on new code. The
    // suite existed the whole time; nothing was measuring it.
    coverage: {
      provider: "v8",
      // lcov for Sonar, text for whoever ran the command.
      reporter: ["text-summary", "lcov"],
      reportsDirectory: "./coverage",
      // What the analyser is asked about. `all` includes files no test touches —
      // leaving them out would report coverage of the tested files only, which is
      // a number that always looks good and never moves.
      all: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test/**",
        // Next.js route files are one-line re-exports of a feature component; the
        // component is covered, and a page shell has nothing of its own to test.
        "src/app/**",
        "src/**/*.d.ts",
      ],
    },
  },
});
