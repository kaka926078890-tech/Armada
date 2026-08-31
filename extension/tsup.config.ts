import { copyFileSync, existsSync, mkdirSync } from "fs";
import { spawnSync } from "child_process";
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
    for (const name of ["armada-spool.sh", "armada-spool.ps1", "armada-spool.cs"] as const) {
      copyFileSync(join("..", "hooks", name), join("hooks", name));
    }
    if (process.platform === "win32") {
      const windir = process.env.WINDIR || "C:\\Windows";
      const csc64 = join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
      const csc32 = join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");
      const csc = existsSync(csc64) ? csc64 : existsSync(csc32) ? csc32 : null;
      if (csc) {
        const r = spawnSync(csc, ["-nologo", `-out:${join("hooks", "armada-spool.exe")}`, join("hooks", "armada-spool.cs")], {
          encoding: "utf8",
          windowsHide: true,
          windowsVerbatimArguments: true,
        });
        if (r.status !== 0) {
          console.warn("csc failed (vsix will compile on activate):", r.stderr || r.stdout || r.status);
        }
      }
    }
  },
});
