import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, utimesSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  capPlanBody,
  enrichPlanAsk,
  loadPlanBodyForName,
  parsePlanMarkdown,
  PLAN_BODY_MAX,
  sanitizePlanFileStem,
  defaultPlanFs,
} from "../src/planFile";

const SAMPLE = `---
name: Markdown date line
overview: 在任意一份现有 markdown 文件末尾追加一行日期，不改其它内容。
todos:
  - id: append-date
    content: 在任意现有 markdown 文件末尾追加一行 2026-09-15
    status: completed
isProject: false
---

# 在 markdown 追加日期

在任意一份现有 markdown 末尾追加一行 \`2026-09-15\`。不改其它内容。
`;

describe("parsePlanMarkdown", () => {
  test("splits Cursor frontmatter from the body the operator must read", () => {
    const p = parsePlanMarkdown(SAMPLE);
    expect(p.name).toBe("Markdown date line");
    expect(p.overview).toContain("追加一行日期");
    expect(p.body).toContain("# 在 markdown 追加日期");
    expect(p.body).not.toContain("todos:");
  });
});

describe("sanitizePlanFileStem", () => {
  test("matches Cursor PlanStorageService.sanitizeFileName", () => {
    expect(sanitizePlanFileStem("Markdown date line")).toBe("markdown_date_line");
    expect(sanitizePlanFileStem("Dual Browser Channels")).toBe("dual_browser_channels");
  });
});

describe("loadPlanBodyForName", () => {
  test("reads ~/.cursor/plans by frontmatter name, not the card overview", () => {
    const home = mkdtempSync(join(tmpdir(), "armada-plans-"));
    const dir = join(home, ".cursor", "plans");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "markdown_date_line_c30bf966.plan.md"), SAMPLE);
    const body = loadPlanBodyForName("Markdown date line", [dir], defaultPlanFs());
    expect(body).toContain("# 在 markdown 追加日期");
    expect(body).toContain("2026-09-15");
  });

  test("newest matching file wins when two slugs share a name", () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-plans2-"));
    const oldP = join(dir, "markdown_date_line_aaaa.plan.md");
    const newP = join(dir, "markdown_date_line_bbbb.plan.md");
    writeFileSync(oldP, SAMPLE.replace("# 在 markdown 追加日期", "# old plan"));
    writeFileSync(newP, SAMPLE.replace("# 在 markdown 追加日期", "# new plan"));
    const ago = new Date(Date.now() - 60_000);
    utimesSync(oldP, ago, ago);
    const body = loadPlanBodyForName("Markdown date line", [dir], defaultPlanFs());
    expect(body).toContain("# new plan");
    expect(body).not.toContain("# old plan");
  });

  test("missing file returns null so CDP overview remains the fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-plans3-"));
    expect(loadPlanBodyForName("No Such Plan", [dir], defaultPlanFs())).toBeNull();
  });
});

describe("enrichPlanAsk", () => {
  test("replaces the Build option text with the plan file body", () => {
    const dir = mkdtempSync(join(tmpdir(), "armada-plans4-"));
    writeFileSync(join(dir, "markdown_date_line_c30bf966.plan.md"), SAMPLE);
    const inspect = enrichPlanAsk({
      present: true,
      kind: "plan",
      filename: "Markdown date line",
      prompt: "Created Plan: Markdown date line",
      conversation_id: "cid-1",
      options: [{ id: "build", label: "Build", text: "在任意一份现有 markdown 文件末尾追加一行日期" }],
    }, [dir]);
    expect(inspect.present && inspect.kind === "plan" ? inspect.options[0].text : "").toContain("# 在 markdown 追加日期");
  });
});

describe("capPlanBody", () => {
  test("truncates with a marker past PLAN_BODY_MAX", () => {
    const t = capPlanBody("x".repeat(PLAN_BODY_MAX + 10));
    expect(t.endsWith("…（计划过长，已截断）")).toBe(true);
    expect(t.length).toBeLessThan(PLAN_BODY_MAX + 40);
  });
});
