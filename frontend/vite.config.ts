import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4000",
      "/healthz": "http://127.0.0.1:4000",
      "/ws": {
        target: "ws://127.0.0.1:4000",
        ws: true,
      },
    },
    allowedHosts: ["localhost", "easy-enters-commonly-pool.trycloudflare.com"],
  },
});
