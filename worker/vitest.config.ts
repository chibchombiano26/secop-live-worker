import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);
const pdfjsPackageDirectory = dirname(
  require.resolve("pdfjs-dist/build/pdf.min.mjs"),
);

export default defineConfig({
  plugins: [
    {
      name: "inline-pdfjs-test-assets",
      enforce: "pre",
      resolveId(source) {
        if (source === "pdfjs-dist-assets:cmaps") return "\0pdfjs-dist-assets:cmaps";
        if (/^pdfjs-dist\/.+\?inline-(?:text|base64)$/.test(source))
          return `\0${source}`;
      },
      load(id) {
        if (id === "\0pdfjs-dist-assets:cmaps") {
          const cmapDirectory = join(pdfjsPackageDirectory, "..", "cmaps");
          const maps = Object.fromEntries(
            readdirSync(cmapDirectory)
              .filter((name) => name.endsWith(".bcmap"))
              .map((name) => [
                name,
                readFileSync(join(cmapDirectory, name)).toString("base64"),
              ]),
          );
          return `export default ${JSON.stringify(maps)};`;
        }
        if (!id.startsWith("\0pdfjs-dist/")) return;
        const [packagePath, encoding] = id.slice(1).split("?");
        const content = readFileSync(require.resolve(packagePath));
        return `export default ${JSON.stringify(
          encoding === "inline-text" ? content.toString("utf8") : content.toString("base64"),
        )};`;
      },
    },
  ],
});
