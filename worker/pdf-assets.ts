import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export function inlinePdfAssets() {
  return {
    name: "inline-pdfjs-assets",
    enforce: "pre" as const,
    resolveId(source: string) {
      if (source === "pdfjs-dist-assets:cmaps")
        return "\0pdfjs-dist-assets:cmaps";
      if (/^pdfjs-dist\/.+\?inline-(?:text|base64)$/.test(source))
        return `\0${source}`;
    },
    load(id: string) {
      if (id === "\0pdfjs-dist-assets:cmaps") {
        const root = dirname(require.resolve("pdfjs-dist/build/pdf.min.mjs"));
        const dir = join(root, "..", "cmaps");
        const maps = Object.fromEntries(
          readdirSync(dir)
            .filter((n) => n.endsWith(".bcmap"))
            .map((n) => [n, readFileSync(join(dir, n)).toString("base64")]),
        );
        return `export default ${JSON.stringify(maps)};`;
      }
      if (!id.startsWith("\0pdfjs-dist/")) return;
      const [path, encoding] = id.slice(1).split("?");
      const bytes = readFileSync(require.resolve(path));
      return `export default ${JSON.stringify(encoding === "inline-text" ? bytes.toString("utf8") : bytes.toString("base64"))};`;
    },
  };
}
