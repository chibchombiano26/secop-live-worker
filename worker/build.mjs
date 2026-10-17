import { builtinModules } from "node:module";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
  stdio: "inherit",
});
const redirectPath = resolve(".wrangler/deploy/config.json");
const redirect = JSON.parse(await readFile(redirectPath, "utf8"));
const configPath = resolve(dirname(redirectPath), redirect.configPath);
const config = JSON.parse(await readFile(configPath, "utf8"));
await build({
  entryPoints: [resolve(dirname(configPath), config.main)],
  bundle: true,
  format: "esm",
  platform: "neutral",
  conditions: ["workerd"],
  mainFields: ["module", "main"],
  external: ["cloudflare:*", "node:*"],
  outfile: "dist/bundle.js",
  logLevel: "warning",
  plugins: [
    {
      name: "cloudflare-node-imports",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (a) =>
          builtinModules.includes(a.path)
            ? { path: `node:${a.path}`, external: true }
            : undefined,
        );
      },
    },
  ],
});
