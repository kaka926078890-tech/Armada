import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ios = readFileSync(join(import.meta.dir, "ios/ArmadaRemote/Screens.swift"), "utf8");
const composer = readFileSync(join(import.meta.dir, "ios/ArmadaRemote/ComposerField.swift"), "utf8");
const android = readFileSync(join(import.meta.dir, "android/app/src/main/java/app/armada/remote/MainActivity.kt"), "utf8");
const models = readFileSync(join(import.meta.dir, "android/core/src/main/kotlin/app/armada/remote/Models.kt"), "utf8");

test("iOS and Android Ask cards show D Other like Cursor, not a lone textarea", () => {
  expect(ios).toContain("func visibleAskOptions");
  expect(ios).toContain("ForEach(visibleAskOptions(q.options))");
  expect(ios).toContain('Text(busyAction == "skip" ? "Skipping..." : "Skip")');
  expect(ios).toContain("busyAction = nil");
  expect(ios).not.toContain("$0.freeform != true");
  expect(android).toContain("visibleAskOptions(");
  expect(android).toContain('if (busy == "skip") "Skipping..." else "Skip"');
  expect(android).toContain("busy = null");
  expect(android).not.toContain("it.freeform != true");
  expect(models).toContain("fun visibleAskOptions");
  expect(models).toContain("fun askOptionBody");
});

test("iOS dispatch composer cannot expand over the Form", () => {
  expect(ios).toContain(".frame(minHeight: 36, maxHeight: 132)");
  expect(ios).toContain(".fixedSize(horizontal: false, vertical: true)");
  expect(composer).toContain("setContentHuggingPriority(.required, for: .vertical)");
});
