import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/ui/",
  build: {
    outDir: "../dist/ui",
    assetsDir: "assets",
  },
  server: {
    proxy: {
      "/api": "http://localhost:8080", // Proxy API calls to Node.js backend during development
      "/upstream": "http://localhost:8080",
      "/unload": "http://localhost:8080",
      "/running": "http://localhost:8080",
    },
  },
});
