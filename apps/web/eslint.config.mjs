import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // apps/web had never been linted before (no config existed at all -
      // `next lint` prompted interactively and failed in CI/non-interactive
      // shells). Enabling this ruleset for the first time surfaced 167
      // pre-existing `any` usages across the app; fixing each one requires
      // picking a correct replacement type per call site, not a mechanical
      // find/replace, so it's tracked as a warning (visible, not blocking)
      // rather than blocking this first lint pass. Ratchet back to "error"
      // once the existing backlog is cleared.
      "@typescript-eslint/no-explicit-any": "warn"
    }
  }
];

export default eslintConfig;
