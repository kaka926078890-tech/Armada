import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/extension.ts"],
  format: ["cjs"],
  external: ["vscode"],
  noExternal: ["ws"],
  outDir: "dist",
  minify: false,
  sourcemap: true,
});
