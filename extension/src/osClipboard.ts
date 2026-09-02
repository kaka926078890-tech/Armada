import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export function writeOsImageClipboard(bytes: Buffer, mime: string): void {
  const dir = mkdtempSync(join(tmpdir(), "armada-clip-"));
  const src = join(dir, mime === "image/png" ? "a.png" : "a.jpg");
  writeFileSync(src, bytes);
  try {
    if (process.platform === "darwin") {
      let png = src;
      if (mime !== "image/png") {
        png = join(dir, "a.png");
        execFileSync("sips", ["-s", "format", "png", src, "--out", png], { timeout: 15_000 });
      }
      execFileSync("osascript", ["-e", `set the clipboard to (read POSIX file ${JSON.stringify(png)} as «class PNGf»)`], { timeout: 10_000 });
      return;
    }
    if (process.platform === "win32") {
      execFileSync("powershell.exe", [
        "-NoProfile", "-STA", "-Command",
        `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Image]::FromFile(${JSON.stringify(src)}); [System.Windows.Forms.Clipboard]::SetImage($i); $i.Dispose()`,
      ], { timeout: 15_000 });
      return;
    }
    throw new Error("CLIPBOARD_UNSUPPORTED_OS");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
