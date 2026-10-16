import pdfjsModule from "pdfjs-dist/build/pdf.min.mjs?inline-text";
import pdfjsWorkerModule from "pdfjs-dist/build/pdf.worker.min.mjs?inline-text";
import pdfjsCMaps from "pdfjs-dist-assets:cmaps";
import foxitDingbats from "pdfjs-dist/standard_fonts/FoxitDingbats.pfb?inline-base64";
import foxitFixed from "pdfjs-dist/standard_fonts/FoxitFixed.pfb?inline-base64";
import foxitFixedBold from "pdfjs-dist/standard_fonts/FoxitFixedBold.pfb?inline-base64";
import foxitFixedBoldItalic from "pdfjs-dist/standard_fonts/FoxitFixedBoldItalic.pfb?inline-base64";
import foxitFixedItalic from "pdfjs-dist/standard_fonts/FoxitFixedItalic.pfb?inline-base64";
import foxitSerif from "pdfjs-dist/standard_fonts/FoxitSerif.pfb?inline-base64";
import foxitSerifBold from "pdfjs-dist/standard_fonts/FoxitSerifBold.pfb?inline-base64";
import foxitSerifBoldItalic from "pdfjs-dist/standard_fonts/FoxitSerifBoldItalic.pfb?inline-base64";
import foxitSerifItalic from "pdfjs-dist/standard_fonts/FoxitSerifItalic.pfb?inline-base64";
import foxitSymbol from "pdfjs-dist/standard_fonts/FoxitSymbol.pfb?inline-base64";
import liberationSansBold from "pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf?inline-base64";
import liberationSansBoldItalic from "pdfjs-dist/standard_fonts/LiberationSans-BoldItalic.ttf?inline-base64";
import liberationSansItalic from "pdfjs-dist/standard_fonts/LiberationSans-Italic.ttf?inline-base64";
import liberationSans from "pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf?inline-base64";
import jbig2Wasm from "pdfjs-dist/wasm/jbig2.wasm?inline-base64";
import openjpegWasm from "pdfjs-dist/wasm/openjpeg.wasm?inline-base64";
import qcmsWasm from "pdfjs-dist/wasm/qcms_bg.wasm?inline-base64";

export const PDFJS_VERSION = "6.4.299";

export const pdfjsAssets: Record<
  string,
  { body: string; encoding: "text" | "base64"; contentType: string }
> = {
  "pdf.mjs": {
    body: pdfjsModule,
    encoding: "text",
    contentType: "text/javascript; charset=utf-8",
  },
  "pdf.worker.mjs": {
    body: pdfjsWorkerModule,
    encoding: "text",
    contentType: "text/javascript; charset=utf-8",
  },
  "wasm/jbig2.wasm": {
    body: jbig2Wasm,
    encoding: "base64",
    contentType: "application/wasm",
  },
  "wasm/openjpeg.wasm": {
    body: openjpegWasm,
    encoding: "base64",
    contentType: "application/wasm",
  },
  "wasm/qcms_bg.wasm": {
    body: qcmsWasm,
    encoding: "base64",
    contentType: "application/wasm",
  },
  "standard_fonts/FoxitDingbats.pfb": {
    body: foxitDingbats,
    encoding: "base64",
    contentType: "application/octet-stream",
  },
  "standard_fonts/FoxitFixed.pfb": {
    body: foxitFixed,
    encoding: "base64",
    contentType: "application/octet-stream",
  },
  "standard_fonts/FoxitFixedBold.pfb": {
    body: foxitFixedBold,
    encoding: "base64",
    contentType: "application/octet-stream",
  },
  "standard_fonts/FoxitFixedBoldItalic.pfb": {
    body: foxitFixedBoldItalic,
    encoding: "base64",
    contentType: "application/octet-stream",
  },
  "standard_fonts/FoxitFixedItalic.pfb": {
    body: foxitFixedItalic,
    encoding: "base64",
    contentType: "application/octet-stream",
  },
  "standard_fonts/FoxitSerif.pfb": {
    body: foxitSerif,
    encoding: "base64",
    contentType: "application/octet-stream",
  },
  "standard_fonts/FoxitSerifBold.pfb": {
    body: foxitSerifBold,
    encoding: "base64",
    contentType: "application/octet-stream",
  },
  "standard_fonts/FoxitSerifBoldItalic.pfb": {
    body: foxitSerifBoldItalic,
    encoding: "base64",
    contentType: "application/octet-stream",
  },
  "standard_fonts/FoxitSerifItalic.pfb": {
    body: foxitSerifItalic,
    encoding: "base64",
    contentType: "application/octet-stream",
  },
  "standard_fonts/FoxitSymbol.pfb": {
    body: foxitSymbol,
    encoding: "base64",
    contentType: "application/octet-stream",
  },
  "standard_fonts/LiberationSans-Bold.ttf": {
    body: liberationSansBold,
    encoding: "base64",
    contentType: "font/ttf",
  },
  "standard_fonts/LiberationSans-BoldItalic.ttf": {
    body: liberationSansBoldItalic,
    encoding: "base64",
    contentType: "font/ttf",
  },
  "standard_fonts/LiberationSans-Italic.ttf": {
    body: liberationSansItalic,
    encoding: "base64",
    contentType: "font/ttf",
  },
  "standard_fonts/LiberationSans-Regular.ttf": {
    body: liberationSans,
    encoding: "base64",
    contentType: "font/ttf",
  },
};

export const pdfjsCMapAssets: Record<string, string> = pdfjsCMaps;
