import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const api = readFileSync(join(import.meta.dir, "ArmadaRemote/RelayAPI.swift"), "utf8");

test("iOS followup decodes explicit outcome instead of inferring 200 vs 201", () => {
  expect(api).toMatch(/struct FollowupResponse: Decodable/);
  expect(api).toMatch(/var outcome: String\?/);
  expect(api).toMatch(/FollowupResponse = try await postPrompt\("\/mobile\/runs\/\\\(runId\)\/followup"/);
});
