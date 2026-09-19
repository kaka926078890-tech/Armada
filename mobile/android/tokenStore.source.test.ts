import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const tokenStore = readFileSync(
  join(import.meta.dir, "app/src/main/java/app/armada/remote/TokenStore.kt"),
  "utf8",
);

test("TokenStore.kt does not fall back to plaintext SharedPreferences", () => {
  expect(tokenStore).not.toMatch(/getOrElse\s*\{\s*plain\s*\}/);
  expect(tokenStore).toMatch(/openSecretStore/);
  expect(tokenStore).not.toMatch(/secret:\s*SharedPreferences\s*=\s*plain/);
});
