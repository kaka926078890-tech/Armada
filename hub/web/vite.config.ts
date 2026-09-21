import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": resolve(root, "src") },
  },
  build: {
    outDir: "dist",
    // WebView2 / packaged Chromium. Default baseline-widely-available (chrome87)
    // asks esbuild to downlevel large rest/destructuring (shadcn/streamdown) and fails.
    target: "es2022",
  },
  server: {
    fs: { allow: [resolve(root, "../..")] },
    proxy: { "/api": "http://127.0.0.1:7380", "/ws": { target: "ws://127.0.0.1:7380", ws: true } },
  },
});
