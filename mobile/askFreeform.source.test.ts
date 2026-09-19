import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ios = readFileSync(join(import.meta.dir, "ios/ArmadaRemote/Screens.swift"), "utf8");
const android = readFileSync(join(import.meta.dir, "android/app/src/main/java/app/armada/remote/MainActivity.kt"), "utf8");

test("iOS and Android Ask cards send freeform Other text, not a D chip", () => {
  expect(ios).toContain('TextField("Other..."');
  expect(ios).toContain('action: typed.isEmpty ? "continue" : "freeform"');
  expect(ios).toContain("$0.freeform != true");
  expect(android).toContain('placeholder = "Other..."');
  expect(android).toContain('put("action", "freeform")');
  expect(android).toContain("it.freeform != true");
});
