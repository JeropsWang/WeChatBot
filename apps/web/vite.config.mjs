import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    port: 4311,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:4310", changeOrigin: true },
      "/bridge": { target: "ws://127.0.0.1:4310", ws: true },
    },
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
