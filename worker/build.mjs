import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const inlineAssetPlugin = {
  name: "inline-pdfjs-assets",
  setup(esbuild) {
    esbuild.onResolve(
      { filter: /^pdfjs-dist-assets:cmaps$/ },
      () => ({ path: "cmaps", namespace: "pdfjs-generated" }),
    );
    esbuild.onLoad(
      { filter: /^cmaps$/, namespace: "pdfjs-generated" },
      () => {
        const packageRoot = dirname(require.resolve("pdfjs-dist/build/pdf.min.mjs"));
        const cmapDirectory = join(packageRoot, "..", "cmaps");
        const files = readdirSync(cmapDirectory).filter((name) => name.endsWith(".bcmap"));
        const maps = Object.fromEntries(
          files.map((name) => [
            name,
            readFileSync(join(cmapDirectory, name)).toString("base64"),
          ]),
        );
        return {
          contents: `export default ${JSON.stringify(maps)};`,
          loader: "js",
        };
      },
    );
    esbuild.onResolve(
      { filter: /^pdfjs-dist\/.+\?inline-(?:text|base64)$/ },
      (args) => ({ path: args.path, namespace: "pdfjs-inline-asset" }),
    );
    esbuild.onLoad(
      { filter: /.*/, namespace: "pdfjs-inline-asset" },
      (args) => {
        const [packagePath, encoding] = args.path.split("?");
        const path = require.resolve(packagePath);
        const bytes = readFileSync(path);
        const value =
          encoding === "inline-text" ? bytes.toString("utf8") : bytes.toString("base64");
        return {
          contents: `export default ${JSON.stringify(value)};`,
          loader: "js",
        };
      },
    );
  },
};

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  conditions: ["workerd"],
  mainFields: ["module", "main"],
  external: ["cloudflare:workers"],
  outfile: "dist/bundle.js",
  logLevel: "warning",
  plugins: [inlineAssetPlugin],
});
