import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["oxc", "typescript", "import", "jsdoc", "promise", "vitest"],
  categories: {
    correctness: "error",
  },
  options: {
    typeAware: true,
  },
  ignorePatterns: ["dist", "node_modules", "coverage", "build", ".agents", "old"],
  rules: {
    "oxc/no-barrel-file": "error",
    "import/extensions": ["error", "always", { checkTypeImports: true, ignorePackages: true }],
  },
});
