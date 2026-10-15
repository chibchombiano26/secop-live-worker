import { DossierError } from "./contracts";
export async function sha256(value: Uint8Array | string) {
  const data =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(data).buffer),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function officialUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DossierError("UNSAFE_DOWNLOAD");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "community.secop.gov.co" ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/Public/Archive/RetrieveFile/Index" ||
    !/^\d+$/.test(url.searchParams.get("DocumentId") ?? "")
  )
    throw new DossierError("UNSAFE_DOWNLOAD");
  return url;
}
export async function boundedBytes(response: Response, maxBytes: number) {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new DossierError("DOCUMENT_TOO_LARGE", 413);
  }
  if (!response.body) throw new DossierError("EMPTY_DOCUMENT");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new DossierError("DOCUMENT_TOO_LARGE", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export function identifyDocument(bytes: Uint8Array, mimeHint = "") {
  const prefix = new TextDecoder().decode(bytes.subarray(0, 512));
  if (
    /<(!doctype|html)|captcha|cloudflare.*challenge/i.test(prefix) ||
    mimeHint.includes("text/html")
  )
    throw new DossierError("HUMAN_HELP_REQUIRED", 409);
  if (prefix.startsWith("%PDF-")) return "application/pdf";
  if (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 3 &&
    bytes[3] === 4
  )
    return "application/zip";
  throw new DossierError("UNSUPPORTED_DOCUMENT", 415);
}
export async function downloadOfficialDocument(
  value: string,
  options: {
    maxBytes?: number;
    fetcher?: typeof fetch;
    timeoutMs?: number;
  } = {},
) {
  let url = officialUrl(value);
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30000);
  try {
    for (let redirect = 0; redirect <= 3; redirect++) {
      const response = await (options.fetcher ?? fetch)(url, {
        redirect: "manual",
        signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (redirect === 3) throw new DossierError("REDIRECT_LIMIT");
        url = officialUrl(
          new URL(response.headers.get("location") ?? "", url).href,
        );
        continue;
      }
      if ([401, 403, 429].includes(response.status)) {
        await response.body?.cancel();
        throw new DossierError("HUMAN_HELP_REQUIRED", 409);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new DossierError("DOWNLOAD_UNAVAILABLE", 502, true);
      }
      const bytes = await boundedBytes(response, maxBytes);
      const mime = identifyDocument(
        bytes,
        response.headers.get("content-type") ?? "",
      );
      return {
        bytes,
        mime,
        hash: await sha256(bytes),
        sourceUrl: url.href,
        fetchedAt: new Date().toISOString(),
      };
    }
    throw new DossierError("REDIRECT_LIMIT");
  } catch (e) {
    if (e instanceof DossierError) throw e;
    throw new DossierError("DOWNLOAD_UNAVAILABLE", 502, true);
  }
}
