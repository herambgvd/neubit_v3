// ESLint 9 flat config. Next 16 removed `next lint`, so lint runs ESLint directly
// (`npm run lint`). eslint-config-next 16 ships flat config arrays — no shim.
//
// The console is mid-migration to strict TypeScript, so the rules that would fire
// on every not-yet-annotated boundary are warnings for now and errors once the
// corresponding tsconfig flag is on. Everything that flags a real defect is an
// error from the start.
import next from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "node_modules/**",
      "public/**",
      "scripts/**",
    ],
  },
  ...next,
  ...nextTypescript,
  {
    rules: {
      // Tracks tsconfig `strict`: while implicit any is still allowed by the
      // compiler, an explicit `any` is a marker, not yet a failure.
      "@typescript-eslint/no-explicit-any": "warn",
      // ~100 components seed local state from props/server data inside an effect
      // ("load this record into the edit form", "reset when the modal opens").
      // With refetchOnWindowFocus off (see components/Providers.tsx) these do not
      // clobber operator input, so they are not defects — they stop the React
      // Compiler from memoizing those components, which is a performance ceiling.
      // Removing them means splitting each form into a child mounted from its
      // record, which is a deliberate refactor with tests, not a blind pass over
      // 89 files. Warn until then; see the README's known gaps for the count.
      "react-hooks/set-state-in-effect": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "src/test/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
];

export default config;
