import { describe, expect, test } from "bun:test";
import { mergeAttachmentFiles } from "../src/attachments";

function png(name: string): File {
  return new File([new Uint8Array([1])], name, { type: "image/png" });
}

describe("mergeAttachmentFiles", () => {
  test("drops a 5th image and reports rejected", () => {
    const { files, rejected } = mergeAttachmentFiles([png("1"), png("2"), png("3"), png("4")], [png("5")]);
    expect(files.map((f) => f.name)).toEqual(["1", "2", "3", "4"]);
    expect(rejected).toBe(1);
  });

  test("ignores gif but keeps pdf/txt", () => {
    const gif = new File([new Uint8Array([1])], "a.gif", { type: "image/gif" });
    const pdf = new File([new Uint8Array([1])], "spec.pdf", { type: "application/pdf" });
    const txt = new File(["x"], "notes.txt", { type: "text/plain" });
    const { files, rejected } = mergeAttachmentFiles([], [gif, pdf, txt, png("a")]);
    expect(files.map((f) => f.name)).toEqual(["spec.pdf", "notes.txt", "a"]);
    expect(rejected).toBe(0);
  });
});
