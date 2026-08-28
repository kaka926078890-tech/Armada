import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { createMiddleware } from "hono/factory";

export function ARMADA_HOME(home?: string): string {
  const h = home ?? process.env.ARMADA_HUB_HOME ?? join(process.env.HOME!, ".armada");
  mkdirSync(h, { recursive: true });
  return h;
}

export function loadToken(home: string): string {
  const p = join(home, "token");
  if (!existsSync(p)) {
    const t = randomBytes(32).toString("hex");
    writeFileSync(p, t, { mode: 0o600 });
    return t;
  }
  return readFileSync(p, "utf8").trim();
}

export const authMiddleware = (token: string) =>
  createMiddleware(async (c, next) => {
    const bearer = c.req.header("authorization");
    const query = new URL(c.req.url).searchParams.get("token");
    const ok = bearer === `Bearer ${token}` || query === token;
    if (!ok) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
