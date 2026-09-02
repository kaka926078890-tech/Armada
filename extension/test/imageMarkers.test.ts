import { describe, expect, test } from "bun:test";
import { collisionKey, displayUserText, hasImageMarkers, stripImageMarkers } from "../src/imageMarkers";

describe("stripImageMarkers", () => {
  test("strips image wrappers and collapses whitespace", () => {
    expect(stripImageMarkers("[Image]\n<image_files>x.png</image_files>\n看这张图")).toBe("看这张图");
  });

  test("empty after strip", () => {
    expect(stripImageMarkers("[Image]\n<image_files>x.png</image_files>")).toBe("");
  });
});

describe("collisionKey", () => {
  test("same text different images do not collide", () => {
    expect(collisionKey("", ["aaa"])).not.toBe(collisionKey("", ["bbb"]));
  });

  test("same text and same ids collide", () => {
    expect(collisionKey(" hi ", ["a", "b"])).toBe(collisionKey("hi", ["a", "b"]));
  });
});

describe("displayUserText", () => {
  test("keeps body after markers", () => {
    expect(displayUserText("[Image]\n看这张图", 1)).toBe("[图片] 看这张图");
  });

  test("image-only", () => {
    expect(displayUserText("[Image]\n<image_files>x.png</image_files>", 2)).toBe("[2 张图片]");
  });
});

describe("hasImageMarkers", () => {
  test("detects transcript form", () => {
    expect(hasImageMarkers("<image_files>x.png</image_files>")).toBe(true);
    expect(hasImageMarkers("hello")).toBe(false);
  });
});
