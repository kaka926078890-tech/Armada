import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(import.meta.dir, "ArmadaRemote/Dictation.swift"), "utf8");

function slice(name: string): string {
  const start = src.indexOf(`func ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf("\n    func ", start + 1);
  const privateNext = src.indexOf("\n    private func ", start + 1);
  const end = [next, privateNext].filter((n) => n > start).sort((a, b) => a - b)[0] ?? src.length;
  return src.slice(start, end);
}

test("dispatch sheet does not construct an audio engine until dictation starts", () => {
  expect(src).not.toMatch(/private let engine = AVAudioEngine\(\)/);
  expect(src).toMatch(/private var engine: AVAudioEngine\?/);
  const begin = slice("beginEngine");
  expect(begin).toMatch(/let engine = AVAudioEngine\(\)/);
});

test("closing dispatch or followup does not touch the shared audio session", () => {
  const release = slice("release");
  expect(release).toMatch(/guard listening \|\| sessionOwned \|\| engine != nil else \{ return \}/);
  const teardown = slice("teardownEngine");
  expect(teardown).toMatch(/if tapped \{[\s\S]*engine\.inputNode\.removeTap/);
  expect(teardown).toMatch(/if owned \{[\s\S]*setActive\(false, options: \.notifyOthersOnDeactivation\)/);
  expect(teardown).not.toMatch(/engine\.inputNode\.removeTap\(onBus: 0\)\n\s*try\? AVAudioSession/);
});

test("dictation ducks other audio instead of taking the record category", () => {
  const begin = slice("beginEngine");
  expect(begin).toMatch(/setCategory\(\s*\.playAndRecord/);
  expect(begin).toMatch(/\.duckOthers/);
  expect(begin).not.toMatch(/setCategory\(\.record/);
  expect(src).not.toMatch(/setCategory\(\.record/);
});
