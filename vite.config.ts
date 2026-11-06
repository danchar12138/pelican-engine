import { defineConfig } from "vite";
import path from "node:path";
export default defineConfig({
  base: "./",
  resolve: {
    alias: { "pelican-engine": path.resolve("packages/sdk/src/index.ts") },
  },
  server: { host: "127.0.0.1", strictPort: true, port: 4173 },
  build: { target: "es2023", sourcemap: true, outDir: "dist" },
});
