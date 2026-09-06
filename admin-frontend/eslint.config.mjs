// ESLint 9 flat config. `next lint` was removed in Next 16, so lint runs ESLint
// directly (`npm run lint`) — see package.json. eslint-config-next 16 ships flat
// config arrays, so no FlatCompat shim is needed.
import next from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  {
    ignores: [".next/**", "out/**", "build/**", "next-env.d.ts", "node_modules/**"],
  },
  ...next,
  ...nextTypescript,
  {
    rules: {
      // The panel is fully TypeScript, so an `any` is a hole in the types rather
      // than an unconverted island — treat it as an error.
      "@typescript-eslint/no-explicit-any": "error",
      // Unused values are dead code; `_`-prefixed names are the escape hatch for
      // deliberately ignored callback arguments.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    // Tests may reach for loose fixtures; keep the rest of the rules.
    files: ["**/*.test.ts", "**/*.test.tsx", "src/test/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
];

export default config;
