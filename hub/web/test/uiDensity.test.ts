import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import {
  ASK_CONTINUE_BTN, ASK_PLAN_BTN, ASK_SKIP_BTN, UI_BTN, UI_CHIP, UI_CHIP_ACCENT, UI_OPTION,
} from "../src/ui";

const srcRoot = join(import.meta.dir, "../src");
const repoRoot = join(import.meta.dir, "../../..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

describe("hub UI density is one scale", () => {
  test("shared tokens: chrome 32px, chips 28px, options same as chrome", () => {
    expect(UI_BTN).toContain("h-8");
    expect(UI_BTN).toContain("text-[13px]");
    expect(UI_CHIP).toContain("h-7");
    expect(UI_CHIP_ACCENT).toContain("h-7");
    expect(UI_CHIP_ACCENT).toContain("bg-sky-800");
    expect(UI_CHIP_ACCENT).not.toContain("bg-zinc-900");
    expect(UI_OPTION).toContain("min-h-8");
    expect(UI_OPTION).not.toContain("min-h-11");
    expect(ASK_CONTINUE_BTN).toContain("h-8");
    expect(ASK_PLAN_BTN).toContain("h-8");
    expect(ASK_SKIP_BTN).toContain("h-8");
    expect(ASK_CONTINUE_BTN).not.toContain("min-h-9");
    expect(ASK_CONTINUE_BTN).not.toContain("min-w-[128px]");
  });

  test("pages do not mix oversized Ask rows or 10px chrome", () => {
    const files = walk(srcRoot).filter((p) => !p.endsWith("/ui.ts"));
    const hits: string[] = [];
    const sizeRe = /(?<![\w-])(?:min-h-9|min-h-11|h-10|h-11)(?![\w-])/;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (text.includes("min-w-[128px]")) hits.push(`${file}: min-w-[128px]`);
      if (text.includes("text-[10px]")) hits.push(`${file}: text-[10px]`);
      if (sizeRe.test(text)) hits.push(`${file}: oversized height`);
    }
    expect(hits).toEqual([]);
  });

  test("pages do not stack color utilities on density tokens", () => {
    const files = walk(srcRoot).filter((p) => !p.endsWith("/ui.ts"));
    const hits: string[] = [];
    const stacked = /\$\{UI_(CHIP|BTN_GHOST|TEXTAREA|BTN)\}[^`]*\b(?:bg-|text-|border-)/;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const line of text.split("\n")) {
        if (stacked.test(line)) hits.push(`${file}: ${line.trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("App UI density is one scale", () => {
  test("iOS and Android primary controls stay 36pt, not 44/48", () => {
    const ios = readFileSync(join(repoRoot, "mobile/ios/ArmadaRemote/Screens.swift"), "utf8");
    const android = readFileSync(join(repoRoot, "mobile/android/app/src/main/java/app/armada/remote/MainActivity.kt"), "utf8");
    const hits: string[] = [];
    if (ios.includes("controlSize(.large)")) hits.push("ios: controlSize(.large)");
    if (/\bminHeight:\s*44\b/.test(ios)) hits.push("ios: minHeight 44");
    if (android.includes("48.dp")) hits.push("android: 48.dp");
    if (android.includes("44.dp")) hits.push("android: 44.dp");
    if (android.includes("width(3.dp)")) hits.push("android: 3dp row accent");
    expect(hits).toEqual([]);
  });
});
