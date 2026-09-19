import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { UI_OPTION } from "../src/ui";

const srcRoot = join(import.meta.dir, "../src");
const repoRoot = join(import.meta.dir, "../../..");
const webRoot = join(import.meta.dir, "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "ui" && dir.endsWith(`${join("src", "components")}`)) continue;
      out.push(...walk(p));
    } else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

describe("hub UI density is one scale", () => {
  test("shadcn primitives: chrome 32px, chips 28px, plan/ask variants", () => {
    const button = readFileSync(join(srcRoot, "components/ui/button.tsx"), "utf8");
    const conf = JSON.parse(readFileSync(join(webRoot, "components.json"), "utf8")) as { style: string };
    const bar = readFileSync(join(srcRoot, "components/PromptSnippetBar.tsx"), "utf8");
    const ask = readFileSync(join(srcRoot, "components/ChatThread.tsx"), "utf8");
    expect(conf.style).toBe("radix-nova");
    expect(button).toContain("text-[13px]");
    expect(button).toContain('"h-8');
    expect(button).toContain('sm: "h-7');
    expect(button).toContain('plan: "bg-plan');
    expect(bar).toContain('size="sm"');
    expect(bar).toContain("rounded-full");
    expect(ask).toContain('variant={plan ? "plan" : "default"}');
    expect(ask).toContain('variant="secondary"');
    expect(UI_OPTION).toContain("min-h-8");
    expect(UI_OPTION).not.toContain("min-h-11");
    expect(button).not.toContain("min-w-[128px]");
  });

  test("thread uses shadcn semantic colors, not zinc (light theme must stay readable)", () => {
    const chat = readFileSync(join(srcRoot, "components/ChatThread.tsx"), "utf8");
    expect(chat).toContain("text-foreground");
    expect(chat).toContain("text-muted-foreground");
    expect(chat).toContain("bg-muted");
    expect(chat).not.toMatch(/\b(?:text|bg|border|hover:text|hover:bg)-zinc-/);
  });

  test("pages do not mix oversized Ask rows or 10px chrome", () => {
    const files = walk(srcRoot).filter((p) => !p.endsWith("/ui.ts") && !p.includes("/components/ui/"));
    const hits: string[] = [];
    const sizeRe = /(?<![\w-])(?:min-h-9|min-h-11|h-10|h-11)(?![\w-])/;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (text.includes("min-w-[128px]")) hits.push(`${file}: min-w-[128px]`);
      if (text.includes("text-sm")) hits.push(`${file}: text-sm`);
      if (text.includes("text-[10px]")) hits.push(`${file}: text-[10px]`);
      if (sizeRe.test(text)) hits.push(`${file}: oversized height`);
    }
    expect(hits).toEqual([]);
  });

  test("pages do not keep hand-rolled chrome tokens", () => {
    const files = walk(srcRoot).filter((p) => !p.endsWith("/ui.ts") && !p.includes("/components/ui/"));
    const hits: string[] = [];
    const banned = /UI_(BTN|CHIP|INPUT|SELECT|TEXTAREA|OVERLAY|PANEL)|ASK_(CONTINUE|PLAN|SKIP)_BTN/;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const line of text.split("\n")) {
        if (banned.test(line)) hits.push(`${file}: ${line.trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("App UI density is one scale", () => {
  test("iOS and Android primary controls stay 36pt, not 44/48", () => {
    const ios = readFileSync(join(repoRoot, "mobile/ios/ArmadaRemote/Screens.swift"), "utf8");
    const android = androidUi();
    const hits: string[] = [];
    if (ios.includes("controlSize(.large)")) hits.push("ios: controlSize(.large)");
    if (/\bminHeight:\s*44\b/.test(ios)) hits.push("ios: minHeight 44");
    if (android.includes("48.dp")) hits.push("android: 48.dp");
    if (/(?<!\d)44\.dp/.test(android)) hits.push("android: 44.dp");
    expect(hits).toEqual([]);
  });

  test("kanban rows use a 3pt left chrome bar like hub, not only a status dot", () => {
    const ios = readFileSync(join(repoRoot, "mobile/ios/ArmadaRemote/Screens.swift"), "utf8");
    const android = androidUi();
    const iosRow = ios.slice(ios.indexOf("struct RunRow"), ios.indexOf("struct BindView"));
    const androidRow = android.slice(android.indexOf("fun RunRow"), android.indexOf("fun DispatchModal"));
    expect(iosRow).toContain("runRowChrome");
    expect(iosRow).toContain("frame(width: 3)");
    expect(iosRow).not.toContain("Circle().fill(statusColor");
    expect(androidRow).toContain("runRowChrome");
    expect(androidRow).toContain("width(3.dp)");
    expect(androidRow).not.toContain("size(8.dp).clip(CircleShape).background(statusColor");
  });

  test("workspace swipe reveals hide and mark-unread on the same trailing edge", () => {
    const ios = readFileSync(join(repoRoot, "mobile/ios/ArmadaRemote/Screens.swift"), "utf8");
    const android = androidUi();
    const iosHome = ios.slice(ios.indexOf("struct WorkspaceHome"), ios.indexOf("struct PromptSnippetChips"));
    const trailing = iosHome.slice(iosHome.indexOf("swipeActions(edge: .trailing"));
    expect(trailing).toContain("标为未读");
    expect(trailing).toContain("隐藏");
    expect(iosHome).not.toContain("swipeActions(edge: .leading");
    const workspace = android.slice(android.indexOf("fun WorkspaceScreen"), android.indexOf("fun RunRow"));
    expect(workspace).toContain("SwipeActionRow");
    expect(workspace).toContain("标为未读");
    expect(workspace).toContain("隐藏");
    expect(workspace).toContain("listOfNotNull");
    expect(workspace).not.toContain("leading = if (vm.canMarkUnread");
  });

  test("dispatch/followup is a capsule composer, not stacked full-width buttons", () => {
    const ios = readFileSync(join(repoRoot, "mobile/ios/ArmadaRemote/Screens.swift"), "utf8");
    const android = androidUi();
    const iosDispatch = ios.slice(ios.indexOf("struct DispatchSheet"), ios.indexOf("struct DetailPromptCard"));
    const androidDispatch = android.slice(android.indexOf("fun DispatchSheet"), android.indexOf("fun RunDetailScreen"));
    expect(ios).toContain("struct ComposerBar");
    expect(android).toContain("fun ComposerBar");
    expect(ios).toContain("width * 0.78");
    expect(android).toContain("weight(0.78f)");
    expect(iosDispatch).not.toContain("VolumeButton");
    expect(iosDispatch).not.toContain("minHeight: 220");
    expect(androidDispatch).not.toContain("220.dp");
    expect(androidDispatch).not.toContain("expand = true");
    expect(android).toContain("size(32.dp)");
  });

  test("Android chrome matches iOS grouped list, capsule composer, swipe, icon action bar", () => {
    const android = androidUi();
    const composer = android.slice(android.indexOf("fun ComposerBar"), android.indexOf("fun UnreadBadge"));
    const workspace = android.slice(android.indexOf("fun WorkspaceScreen"), android.indexOf("fun RunRow"));
    const actionBar = android.slice(android.indexOf("fun DetailActionBar"), android.indexOf("fun AskBlock"));
    expect(android).toContain("查看已隐藏");
    expect(android).toContain("F2F2F7");
    expect(android).toContain("1C1C1E");
    expect(composer).toContain("IosTextField");
    expect(composer).not.toContain("OutlinedTextField");
    expect(composer).toContain("IosIcon.Mic");
    expect(composer).toContain("IosIcon.ArrowUp");
    expect(workspace).toContain("SwipeActionRow");
    expect(workspace).not.toContain("TextButton");
    expect(actionBar).toContain("IosIcon.Copy");
    expect(actionBar).toContain("IosIcon.Unread");
    expect(android).toContain("\"–\"");
  });
});

function androidUi(): string {
  const main = readFileSync(join(repoRoot, "mobile/android/app/src/main/java/app/armada/remote/MainActivity.kt"), "utf8");
  const chrome = readFileSync(join(repoRoot, "mobile/android/app/src/main/java/app/armada/remote/IosChrome.kt"), "utf8");
  const logic = readFileSync(join(repoRoot, "mobile/android/core/src/main/kotlin/app/armada/remote/Chrome.kt"), "utf8");
  return `${chrome}\n${main}\n${logic}`;
}
