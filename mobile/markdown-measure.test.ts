import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { MEASURE_JS } from "./markdown-measure";

const root = join(dirname(fileURLToPath(import.meta.url)));

type MeasureEl = {
  tagName: string;
  previousElementSibling: MeasureEl | null;
  marginBottom: number;
  getBoundingClientRect: () => { top: number; bottom: number };
};

type MeasureEnv = {
  offsetHeight: number;
  bodyTop?: number;
  bodyBottom?: number;
  lastBottom: number;
  lastMarginBottom?: number;
  /** Tag of the real content block. Old cases stay a box, never SCRIPT. */
  lastTagName?: string;
  htmlScrollHeight?: number;
  /** Empty-box nodes appended after the content block. The last one is lastElementChild. */
  tail?: Array<{ tagName: "SCRIPT" | "STYLE"; bottom?: number; marginBottom?: number }>;
};

function box(tagName: string, bottom: number, marginBottom: number, previous: MeasureEl | null): MeasureEl {
  return {
    tagName,
    previousElementSibling: previous,
    marginBottom,
    getBoundingClientRect: () => ({ top: 0, bottom }),
  };
}

function runMeasure(js: string, opts: MeasureEnv): number {
  let last = box(opts.lastTagName ?? "P", opts.lastBottom, opts.lastMarginBottom ?? 0, null);
  for (const node of opts.tail ?? []) {
    last = box(node.tagName, node.bottom ?? 0, node.marginBottom ?? 0, last);
  }
  const body = {
    offsetHeight: opts.offsetHeight,
    lastElementChild: last,
    getBoundingClientRect: () => ({
      top: opts.bodyTop ?? 0,
      bottom: opts.bodyBottom ?? opts.offsetHeight,
    }),
  };
  const document = {
    body,
    documentElement: { scrollHeight: opts.htmlScrollHeight ?? opts.offsetHeight },
  };
  const getComputedStyle = (el: { marginBottom?: number }) => ({ marginBottom: String(el?.marginBottom ?? 0) });
  return Number(new Function("document", "getComputedStyle", `"use strict"; return (${js});`)(document, getComputedStyle));
}

describe("markdown content height", () => {
  test("includes last-block margin that body.offsetHeight drops", () => {
    expect(runMeasure(MEASURE_JS, { offsetHeight: 100, lastBottom: 100, lastMarginBottom: 8 })).toBe(108);
  });

  test("does not keep the WKWebView frame via documentElement.scrollHeight", () => {
    expect(
      runMeasure(MEASURE_JS, {
        offsetHeight: 2000,
        bodyBottom: 2000,
        lastBottom: 80,
        lastMarginBottom: 8,
        htmlScrollHeight: 2000,
      }),
    ).toBe(88);
  });

  test("grows when the last block is taller than the measured offsetHeight", () => {
    expect(runMeasure(MEASURE_JS, { offsetHeight: 100, lastBottom: 140 })).toBe(140);
  });

  test("ceils fractional line boxes so the last line is not clipped", () => {
    expect(runMeasure(MEASURE_JS, { offsetHeight: 100.2, lastBottom: 100.2 })).toBe(101);
  });

  test("uses the content block before a trailing script or style with an empty box", () => {
    const page = {
      offsetHeight: 80,
      bodyBottom: 80,
      lastBottom: 400,
      lastMarginBottom: 8,
      htmlScrollHeight: 2000,
    };
    expect(runMeasure(MEASURE_JS, { ...page, tail: [{ tagName: "SCRIPT", bottom: 0 }] })).toBe(408);
    expect(runMeasure(MEASURE_JS, { ...page, tail: [{ tagName: "STYLE", bottom: 0 }] })).toBe(408);
    expect(
      runMeasure(MEASURE_JS, {
        ...page,
        tail: [
          { tagName: "SCRIPT", bottom: 0 },
          { tagName: "SCRIPT", bottom: 0 },
        ],
      }),
    ).toBe(408);
  });

  test("ios and android embed the same measure script", () => {
    const swift = readFileSync(join(root, "ios/ArmadaRemote/MarkdownView.swift"), "utf8");
    const kt = readFileSync(join(root, "android/core/src/main/kotlin/app/armada/remote/MarkdownHtml.kt"), "utf8");
    expect(swift).toContain(MEASURE_JS);
    expect(kt).toContain(MEASURE_JS);
  });
});
