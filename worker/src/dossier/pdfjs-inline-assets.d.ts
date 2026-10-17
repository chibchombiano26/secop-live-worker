declare module "*?inline-text" {
  const source: string;
  export default source;
}

declare module "*?inline-base64" {
  const source: string;
  export default source;
}

declare module "pdfjs-dist-assets:cmaps" {
  const assets: Record<string, string>;
  export default assets;
}
