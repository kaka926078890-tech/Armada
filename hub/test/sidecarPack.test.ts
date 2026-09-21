import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "../..");
const BUNDLE_HUB = join(ROOT, "desktop/scripts/bundle-hub.sh");
/** hub/src/index.ts imports these trees outside hub/src; packaged dest must mirror the repo. */
const EXTRA_TREES = ["relay/src", "hub/web/src", "desktop-core/src"] as const;
const EXTENSION_FILES = [
  "promptNormalize.ts",
  "workspacePath.ts",
  "transcriptBind.ts",
  "imageMarkers.ts",
] as const;

function materializeSidecar(dest: string, extras: boolean) {
  mkdirSync(join(dest, "hub/src"), { recursive: true });
  mkdirSync(join(dest, "extension/src"), { recursive: true });
  cpSync(join(ROOT, "hub/src"), join(dest, "hub/src"), { recursive: true });
  for (const f of EXTENSION_FILES) {
    cpSync(join(ROOT, "extension/src", f), join(dest, "extension/src", f));
  }
  if (!extras) return;
  for (const tree of EXTRA_TREES) {
    mkdirSync(join(dest, tree), { recursive: true });
    cpSync(join(ROOT, tree), join(dest, tree), { recursive: true });
  }
}

async function importHubModule(dest: string, spec: string) {
  const proc = Bun.spawn(["bun", "--eval", `await import('${spec}')`], {
    cwd: join(dest, "hub"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stderr };
}

describe("packaged sidecar hub", () => {
  test("bundle-hub.sh copies extra trees hub/src imports outside hub/src", () => {
    const sh = readFileSync(BUNDLE_HUB, "utf8");
    for (const tree of EXTRA_TREES) {
      expect(sh.includes(`"$ROOT/${tree}`)).toBe(true);
    }
  });

  test("bundle-hub.sh smokes src/index.ts not a subset of hub modules", () => {
    const sh = readFileSync(BUNDLE_HUB, "utf8");
    expect(sh).toContain("import('./src/index.ts')");
  });

  test("relayClient cannot load from a hub-only dest", async () => {
    const dest = mkdtempSync(join(tmpdir(), "armada-sidecar-miss-"));
    try {
      materializeSidecar(dest, false);
      const r = await importHubModule(dest, "./src/relayClient.ts");
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("relay/src/uri");
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("cursorReloadStore cannot load from a hub-only dest", async () => {
    const dest = mkdtempSync(join(tmpdir(), "armada-sidecar-reload-miss-"));
    try {
      materializeSidecar(dest, false);
      const r = await importHubModule(dest, "./src/cursorReloadStore.ts");
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("desktop-core/src/cursorReload");
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("relayClient loads when extra trees mirror the repo", async () => {
    const dest = mkdtempSync(join(tmpdir(), "armada-sidecar-ok-"));
    try {
      materializeSidecar(dest, true);
      const r = await importHubModule(dest, "./src/relayClient.ts");
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("cursorReloadStore loads when extra trees mirror the repo", async () => {
    const dest = mkdtempSync(join(tmpdir(), "armada-sidecar-reload-ok-"));
    try {
      materializeSidecar(dest, true);
      const r = await importHubModule(dest, "./src/cursorReloadStore.ts");
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  test("macOS pack does not force ad-hoc signingIdentity", () => {
    const conf = readFileSync(join(ROOT, "desktop/src-tauri/tauri.conf.json"), "utf8");
    expect(conf).not.toMatch(/"signingIdentity"\s*:\s*"-"/);
    const sh = readFileSync(join(ROOT, "desktop/scripts/tauri-build.sh"), "utf8");
    expect(sh).toContain("macos-signing-identity.sh");
    expect(sh).toContain("APPLE_SIGNING_IDENTITY");
  });

  test("pack-time resources copies and installers are gitignored; .gitkeep is not", () => {
    const ignored = (rel: string) =>
      Bun.spawnSync(["git", "check-ignore", "-q", "--", rel], { cwd: ROOT }).exitCode === 0;
    for (const rel of [
      "desktop/src-tauri/resources/desktop-core/src/cursorReload.ts",
      "desktop/src-tauri/resources/hub/src/index.ts",
      "desktop/src-tauri/resources/relay/src/server.ts",
      "desktop/src-tauri/resources/extension/src/promptNormalize.ts",
      "desktop/src-tauri/resources/bun",
      "desktop/src-tauri/resources/bun.exe",
      "desktop/src-tauri/resources/armada-agent-0.4.41.vsix",
      "mobile/android/app/google-services.json",
      "mobile/android/local.properties",
      "mobile/android/app/release.keystore",
      "ArmadaRemote.apk",
      "ArmadaRemote.ipa",
      "Armada.dmg",
      "AuthKey_TEST.p8",
      ".env",
      "secrets.env",
      "N-Armada.log",
      "relay.json",
      "hub.db",
      "pending-reload.json",
      "credentials.json",
      "service-account.json",
    ]) {
      expect(ignored(rel), rel).toBe(true);
    }
    expect(ignored("desktop/src-tauri/resources/.gitkeep")).toBe(false);
    expect(ignored("desktop-core/src/cursorReload.ts")).toBe(false);
    expect(ignored("mobile/ios/ExportOptions.plist")).toBe(false);
  });
});
