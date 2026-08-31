import { copyFileSync, mkdirSync } from "fs";
import { join } from "path";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/extension.ts"],
  format: ["cjs"],
  external: ["vscode"],
  noExternal: ["ws"],
  outDir: "dist",
  minify: false,
  sourcemap: true,
  async onSuccess() {
    mkdirSync("hooks", { recursive: true });
    for (const name of ["armada-spool.sh", "armada-spool.ps1"] as const) {
      copyFileSync(join("..", "hooks", name), join("hooks", name));
    }
  },
});
