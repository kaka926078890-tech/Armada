import { describe, expect, test } from "bun:test";
import { mergeImageFiles } from "../src/attachments";

function png(name: string): File {
  return new File([new Uint8Array([1])], name, { type: "image/png" });
}

describe("mergeImageFiles", () => {
  test("drops a 5th image and reports rejected", () => {
    const { files, rejected } = mergeImageFiles([png("1"), png("2"), png("3"), png("4")], [png("5")]);
    expect(files.map((f) => f.name)).toEqual(["1", "2", "3", "4"]);
    expect(rejected).toBe(1);
  });

  test("ignores non png/jpeg", () => {
    const gif = new File([new Uint8Array([1])], "a.gif", { type: "image/gif" });
    const { files, rejected } = mergeImageFiles([], [gif, png("a")]);
    expect(files.map((f) => f.name)).toEqual(["a"]);
    expect(rejected).toBe(0);
  });
});
