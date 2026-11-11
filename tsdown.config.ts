import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "./src/index.ts",
  format: "esm",
  exports: true,
  sourcemap: false,
  clean: true,
  platform: "neutral",
  attw: {
    profile: "esm-only",
  },
  publint: {
    level: "suggestion",
  },
});
