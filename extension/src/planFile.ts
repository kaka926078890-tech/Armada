import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { AskInspect } from "./askDetect";

export const PLAN_BODY_MAX = 24_000;

export type PlanFs = {
  isDir: (dir: string) => boolean;
  readdir: (dir: string) => string[];
  readFile: (path: string) => string;
  mtime: (path: string) => number;
  join: (...parts: string[]) => string;
};

export function defaultPlanFs(): PlanFs {
  return {
    isDir: (dir) => {
      try { return statSync(dir).isDirectory(); } catch { return false; }
    },
    readdir: (dir) => readdirSync(dir),
    readFile: (path) => readFileSync(path, "utf8"),
    mtime: (path) => statSync(path).mtimeMs,
    join,
  };
}

/** Cursor PlanStorageService.sanitizeFileName */
export function sanitizePlanFileStem(name: string): string {
  return name
    .toLowerCase()
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 100);
}

export function parsePlanMarkdown(raw: string): { name: string; overview: string; body: string } {
  const m = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  const fm = m ? m[1] : "";
  const body = (m ? raw.slice(m[0].length) : raw).trim();
  const name = (fm.match(/^name:\s*(.+)$/m)?.[1] ?? "").trim();
  const overview = (fm.match(/^overview:\s*(.+)$/m)?.[1] ?? "").trim();
  return { name, overview, body };
}

export function capPlanBody(text: string): string {
  const t = text.trim();
  if (t.length <= PLAN_BODY_MAX) return t;
  return `${t.slice(0, PLAN_BODY_MAX)}\n\n…（计划过长，已截断）`;
}

export function planDirsFor(homedir: string, workspaceRoot: string): string[] {
  const home = join(homedir, ".cursor", "plans");
  const ws = workspaceRoot ? join(workspaceRoot, ".cursor", "plans") : "";
  return ws && ws !== home ? [home, ws] : [home];
}

export function loadPlanBodyForName(filename: string, dirs: string[], fs: PlanFs): string | null {
  const want = filename.trim();
  if (!want) return null;
  const slug = sanitizePlanFileStem(want);
  const hits: { mtime: number; text: string }[] = [];
  for (const dir of dirs) {
    if (!fs.isDir(dir)) continue;
    let names: string[] = [];
    try { names = fs.readdir(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".plan.md")) continue;
      const stem = name.slice(0, -".plan.md".length);
      const slugHit = stem === slug || stem.startsWith(`${slug}_`);
      const path = fs.join(dir, name);
      let raw = "";
      try { raw = fs.readFile(path); } catch { continue; }
      const parsed = parsePlanMarkdown(raw);
      if (!slugHit && parsed.name !== want) continue;
      const text = capPlanBody(parsed.body || parsed.overview);
      if (!text) continue;
      hits.push({ mtime: fs.mtime(path), text });
    }
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits[0].text;
}

export function enrichPlanAsk(inspect: AskInspect, dirs: string[], fs: PlanFs = defaultPlanFs()): AskInspect {
  if (!inspect.present || inspect.kind !== "plan" || !inspect.filename) return inspect;
  const body = loadPlanBodyForName(inspect.filename, dirs, fs);
  if (!body) return inspect;
  const prev = inspect.options[0]?.text?.trim() ?? "";
  if (body === prev) return inspect;
  return {
    ...inspect,
    options: [{ id: "build", label: "Build", text: body }],
  };
}
