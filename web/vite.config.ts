import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname),
  plugins: [react()],
  server: {
    port: 5173,
    host: process.env.VITE_HOST ?? "127.0.0.1",
    ...(process.env.VITE_ALLOWED_HOSTS
      ? {
          allowedHosts: process.env.VITE_ALLOWED_HOSTS.split(",")
            .map((host) => host.trim())
            .filter(Boolean),
        }
      : {}),
    proxy: {
      "/api": "http://127.0.0.1:4310",
      "/files": "http://127.0.0.1:4310",
    },
  },
  build: { outDir: "../web-dist", emptyOutDir: true },
});
