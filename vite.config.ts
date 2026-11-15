import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // The live demo is served from the /billpay-guard/ subpath on GitHub
  // Pages — WITHOUT this base, a plain `npm run build` emits root-absolute
  // asset URLs (/assets/...) that 404 on the live site. (A sibling project
  // broke its demo this way on 15 Nov 2026; the base is part of the config
  // from day one so it cannot happen here.)
  base: "/billpay-guard/",
  server: { port: 5173 },
});
