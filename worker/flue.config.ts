import { defineConfig } from "@flue/runtime/config";
export default defineConfig({
  target: "cloudflare",
  providers: ["openrouter"],
  tracing: false,
  agents: "agents/**/*.ts",
});
