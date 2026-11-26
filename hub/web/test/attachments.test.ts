import { describe, expect, test } from "bun:test";
import { ATTACHMENT_NAME_DISPLAY_MAX, attachmentPickMessage, displayAttachmentName, mergeAttachmentFiles, parseRunAttachmentIds } from "../src/attachments";

function png(name: string): File {
  return new File([new Uint8Array([1])], name, { type: "image/png" });
}

describe("mergeAttachmentFiles", () => {
  test("drops files past the caller cap and reports rejected", () => {
    const { files, rejected } = mergeAttachmentFiles([png("1"), png("2"), png("3"), png("4")], [png("5")], 4);
    expect(files.map((f) => f.name)).toEqual(["1", "2", "3", "4"]);
    expect(rejected).toBe(1);
  });

  test("keeps office and zip, and reports gif as unsupported", () => {
    const gif = new File([new Uint8Array([1])], "a.gif", { type: "image/gif" });
    const pdf = new File([new Uint8Array([1])], "spec.pdf", { type: "application/pdf" });
    const docx = new File([new Uint8Array([1])], "brief.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    const zip = new File([new Uint8Array([1])], "logs.zip", { type: "application/zip" });
    const txt = new File(["x"], "notes.txt", { type: "text/plain" });
    const { files, rejected, unsupported } = mergeAttachmentFiles([], [gif, pdf, docx, zip, txt, png("a")]);
    expect(files.map((f) => f.name)).toEqual(["spec.pdf", "brief.docx", "logs.zip", "notes.txt", "a"]);
    expect(rejected).toBe(0);
    expect(unsupported).toBe(1);
    expect(attachmentPickMessage(0, 1, 32)).toBe("不支持的文件类型");
  });
});

describe("displayAttachmentName", () => {
  test("keeps short names", () => {
    expect(displayAttachmentName("shot.png")).toBe("shot.png");
    expect(displayAttachmentName("")).toBe("粘贴的图片");
  });

  test("ellipsizes a Feishu-length jpeg and stays within the cap", () => {
    const long = "img_v3_0215n_5cf580dd-ad94-4f31-95b8-477e2325cddg.jpg";
    const shown = displayAttachmentName(long);
    expect(shown.length).toBe(ATTACHMENT_NAME_DISPLAY_MAX);
    expect(shown.endsWith("….jpg")).toBe(true);
    expect(shown).not.toBe(long);
    expect(shown.startsWith("img_v3_0215n_")).toBe(true);
  });
});

describe("parseRunAttachmentIds", () => {
  test("reads a json array of sha256 ids", () => {
    expect(parseRunAttachmentIds(JSON.stringify(["abc", "def"]))).toEqual(["abc", "def"]);
    expect(parseRunAttachmentIds("[]")).toEqual([]);
    expect(parseRunAttachmentIds(null)).toEqual([]);
    expect(parseRunAttachmentIds("nope")).toEqual([]);
  });
});
