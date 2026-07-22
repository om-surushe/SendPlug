import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8000", "/auth": "http://localhost:8000" } },
});
