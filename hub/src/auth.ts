import { readFileSync, existsSync, mkdirSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { createMiddleware } from "hono/factory";
import { writeFileAtomic } from "./writeFileAtomic";

export function ARMADA_HOME(home?: string): string {
  const h = home ?? process.env.ARMADA_HUB_HOME ?? join(process.env.HOME!, ".armada");
  mkdirSync(h, { recursive: true });
  return h;
}

export function loadToken(home: string): string {
  const p = join(home, "token");
  if (!existsSync(p)) {
    const t = randomBytes(32).toString("hex");
    writeFileAtomic(p, t, 0o600);
    return t;
  }
  return readFileSync(p, "utf8").trim();
}

export function allowsQueryToken(method: string, path: string): boolean {
  if (method.toUpperCase() !== "GET") return false;
  if (path === "/api/events" || path === "/api/audit/export") return true;
  return /^\/api\/runs\/[^/]+\/stream$/.test(path);
}

export const authMiddleware = (token: string) =>
  createMiddleware(async (c, next) => {
    const bearer = c.req.header("authorization");
    const url = new URL(c.req.url);
    const query = url.searchParams.get("token");
    const queryOk = allowsQueryToken(c.req.method, url.pathname) && query === token;
    const ok = bearer === `Bearer ${token}` || queryOk;
    if (!ok) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
