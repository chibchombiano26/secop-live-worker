import { defineConfig } from "vite";
import { flue, flueWorkerConfig } from "@flue/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { inlinePdfAssets } from "./pdf-assets.ts";
export default defineConfig({
  plugins: [
    flue(),
    inlinePdfAssets(),
    cloudflare({
      configPath: "wrangler.flue.jsonc",
      config: flueWorkerConfig(),
    }),
  ],
});
