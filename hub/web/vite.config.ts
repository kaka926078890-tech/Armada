import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist" },
  server: {
    fs: { allow: [resolve(root, "../..")] },
    proxy: { "/api": "http://127.0.0.1:7380", "/ws": { target: "ws://127.0.0.1:7380", ws: true } },
  },
});
