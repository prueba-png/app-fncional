import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_PORT = Number(process.env.DEVSTUDIO_PORT ?? 8787);

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 2500,
    // Versión de un solo archivo y demo publicada: todo el JavaScript en un único fichero
    ...(process.env.SINGLE_FILE === "1" ? { rollupOptions: { output: { inlineDynamicImports: true } } } : {}),
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
} as Parameters<typeof defineConfig>[0]);
