#!/usr/bin/env node
// Unpack the current armada-agent vsix into ~/.cursor/extensions and point
// extensions.json at it. Same directory layout as desktop attach unpack.
// Does not Reload Window.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extDir = path.join(root, "extension");
const pkg = JSON.parse(fs.readFileSync(path.join(extDir, "package.json"), "utf8"));
const version = String(pkg.version || "");
if (!version) {
  console.error("error: extension version missing");
  process.exit(1);
}

const vsix = path.join(extDir, `armada-agent-${version}.vsix`);
if (!fs.existsSync(vsix)) {
  const tsup = path.join(extDir, "node_modules", ".bin", process.platform === "win32" ? "tsup.cmd" : "tsup");
  if (fs.existsSync(tsup)) execFileSync(tsup, [], { cwd: extDir, stdio: "inherit" });
  else execFileSync("npx", ["tsup"], { cwd: extDir, stdio: "inherit", shell: true });
  execFileSync(
    "npx",
    ["--yes", "@vscode/vsce", "package", "--no-dependencies", "--allow-missing-repository", "--skip-license"],
    { cwd: extDir, stdio: "inherit", shell: true },
  );
}
if (!fs.existsSync(vsix)) {
  console.error(`error: missing ${vsix}`);
  process.exit(1);
}

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "armada-vsix-"));
execFileSync("tar", ["-xf", vsix, "-C", staging], { stdio: "inherit" });
const packed = path.join(staging, "extension");
if (!fs.existsSync(path.join(packed, "package.json"))) {
  console.error("error: vsix has no extension/package.json");
  process.exit(1);
}

const extensionsDir = process.env.ARMADA_CURSOR_EXTENSIONS
  || path.join(os.homedir(), ".cursor", "extensions");
fs.mkdirSync(extensionsDir, { recursive: true });
const folderName = `armada.armada-agent-${version}`;
const dest = path.join(extensionsDir, folderName);
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(packed, dest, { recursive: true });
const manifest = path.join(staging, "extension.vsixmanifest");
if (fs.existsSync(manifest)) fs.copyFileSync(manifest, path.join(dest, ".vsixmanifest"));

const fsPath = dest;
const slash = fsPath.replace(/\\/g, "/");
const drive = slash.length >= 2 && slash[1] === ":";
const posix = drive ? `/${slash[0].toLowerCase()}${slash.slice(1)}` : slash;
const external = drive ? `file:///${slash[0].toLowerCase()}%3A${slash.slice(2)}` : `file://${slash}`;
const location = { $mid: 1, fsPath, external, path: posix, scheme: "file" };
const jsonPath = path.join(extensionsDir, "extensions.json");
let arr = [];
if (fs.existsSync(jsonPath)) {
  const raw = fs.readFileSync(jsonPath, "utf8").trim();
  if (raw) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error("error: extensions.json is not an array");
      process.exit(1);
    }
    arr = parsed;
  }
}
const now = Date.now();
let found = false;
for (const item of arr) {
  if (item?.identifier?.id !== "armada.armada-agent") continue;
  item.version = version;
  item.relativeLocation = folderName;
  item.location = location;
  const md = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
  md.installedTimestamp = now;
  md.source = "vsix";
  md.pinned = true;
  item.metadata = md;
  found = true;
  break;
}
if (!found) {
  arr.push({
    identifier: { id: "armada.armada-agent" },
    version,
    relativeLocation: folderName,
    location,
    metadata: {
      isApplicationScoped: false,
      isMachineScoped: false,
      isBuiltin: false,
      installedTimestamp: now,
      pinned: true,
      source: "vsix",
    },
  });
}
fs.writeFileSync(jsonPath, JSON.stringify(arr));
console.log(`ok ${version} -> ${dest}`);
