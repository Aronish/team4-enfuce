import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      // During local development, forward /api/* to the Hono server
      // running on port 8000 (deno task dev:server).
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});