import { DossierError } from "./contracts";
import { sha256 } from "./downloads";
import { DossierRepository, type DossierEnv } from "./repository";
import type { DocumentVersion } from "./inventory";
import { PDFJS_VERSION } from "./pdfjs-assets";

type SourceTicket = {
  hash: string;
  expiresAt: number;
  documentId: string;
  dossierId: string;
  fileId: string;
  page?: number;
};

const invalidTicket = () => new DossierError("SOURCE_TICKET_INVALID", 404);

export async function hasStoredPdf(
  repo: DossierRepository,
  document: { dossierId?: unknown; fileId?: unknown; state?: unknown },
  dossierId: string,
) {
  if (
    document.dossierId !== dossierId ||
    typeof document.fileId !== "string" ||
    !/^[A-Za-z0-9._-]{1,200}$/.test(document.fileId) ||
    document.state === "deleted"
  )
    return false;
  const file = await repo.headFile(document.fileId);
  return file?.httpMetadata?.contentType === "application/pdf";
}

export async function createSourceTicket(
  repo: DossierRepository,
  input: {
    documentId: string;
    dossierId: string;
    document: { dossierId?: unknown; fileId?: unknown; state?: unknown };
    page?: number;
  },
) {
  const document = input.document;
  if (
    document.dossierId !== input.dossierId ||
    typeof document.fileId !== "string" ||
    document.state === "deleted"
  )
    throw invalidTicket();
  const id = crypto.randomUUID();
  const secret = crypto.randomUUID() + crypto.randomUUID();
  const expiresAt = repo.now() + 600_000;
  await repo.save<SourceTicket>(
    "source",
    id,
    {
      hash: await sha256(secret),
      expiresAt,
      documentId: input.documentId,
      dossierId: input.dossierId,
      fileId: document.fileId,
      ...(input.page === undefined ? {} : { page: input.page }),
    },
    0,
  );
  return {
    token: `${repo.context.ownerId}.${id}.${secret}`,
    expiresAt,
    ...(input.page === undefined ? {} : { page: input.page }),
  };
}

async function resolveSourceTicket(
  env: DossierEnv,
  token: string,
  now = Date.now(),
) {
  const [ownerId, id, secret, ...extra] = token.split(".");
  if (
    extra.length ||
    !ownerId ||
    !id ||
    !secret ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(ownerId)
  )
    throw invalidTicket();
  const repo = new DossierRepository(
    env,
    { ownerId, scopes: ["dossier:read"] },
    () => now,
  );
  let ticket;
  try {
    ticket = await repo.read<SourceTicket>("source", id);
  } catch {
    throw invalidTicket();
  }
  if (
    ticket.value.expiresAt <= now ||
    ticket.value.hash !== (await sha256(secret))
  )
    throw invalidTicket();
  let document;
  try {
    document = await repo.read<DocumentVersion>("document", ticket.value.documentId);
  } catch {
    throw invalidTicket();
  }
  if (
    document.value.dossierId !== ticket.value.dossierId ||
    document.value.fileId !== ticket.value.fileId ||
    !(await hasStoredPdf(repo, document.value, ticket.value.dossierId))
  )
    throw invalidTicket();
  return { repo, ticket: ticket.value };
}

export async function readSourceTicket(
  env: DossierEnv,
  token: string,
  now = Date.now(),
) {
  const { repo, ticket } = await resolveSourceTicket(env, token, now);
  const file = await repo.getFile(ticket.fileId);
  if (!file) throw invalidTicket();
  const headers = new Headers({
    "Content-Type": "application/pdf",
    "Content-Disposition": 'attachment; filename="source.pdf"',
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  if (file.size !== undefined) headers.set("Content-Length", String(file.size));
  return new Response(file.body, { status: 200, headers });
}

export async function sourceViewerPage(
  env: DossierEnv,
  token: string,
  now = Date.now(),
) {
  await resolveSourceTicket(env, token, now);
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const sourcePath = `/private/source/${encodeURIComponent(token)}`;
  const modulePath = `/private/source-assets/pdfjs-${PDFJS_VERSION}`;
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fuente del expediente</title>
<style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;background:#e8ebef;color:#18212b;font:16px system-ui,-apple-system,sans-serif}header{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:center;gap:.65rem;flex-wrap:wrap;padding:.65rem;background:#fff;border-bottom:1px solid #ccd2d9}button,input,a{font:inherit}button,a{border:1px solid #aeb8c3;border-radius:.35rem;background:#fff;color:#18212b;padding:.4rem .65rem;text-decoration:none}button:disabled{opacity:.45}input{width:4.2rem;padding:.35rem;text-align:center}#status{min-height:1.5rem;padding:.65rem;text-align:center}#retry-row{text-align:center}main{padding:1rem;display:flex;justify-content:center}canvas{max-width:100%;height:auto;background:#fff;box-shadow:0 2px 12px #24303c33}#download{font-weight:600}@media(max-width:600px){header{gap:.35rem;padding:.5rem}main{padding:.4rem}}
</style></head><body>
<header aria-label="Controles del documento"><button id="prev" type="button" aria-label="Página anterior">←</button><label for="page">Página</label><input id="page" type="number" min="1" value="1" aria-label="Número de página"><span aria-hidden="true">/</span><span id="total">…</span><button id="next" type="button" aria-label="Página siguiente">→</button><a id="download" href="${sourcePath}" download="source.pdf">Descargar original</a></header>
<p id="status" role="status" aria-live="polite">Cargando documento…</p><p id="retry-row"><button id="retry" type="button" hidden>Reintentar</button></p><main><canvas id="page-canvas" aria-label="Página del documento PDF"></canvas></main>
<script type="module" nonce="${nonce}">
import * as pdfjsLib from "${modulePath}/pdf.mjs";
const pageInput=document.querySelector("#page"),total=document.querySelector("#total"),status=document.querySelector("#status"),canvas=document.querySelector("#page-canvas"),prev=document.querySelector("#prev"),next=document.querySelector("#next"),retry=document.querySelector("#retry");
pdfjsLib.GlobalWorkerOptions.workerSrc="${modulePath}/pdf.worker.mjs";
let pdf,current=1,renderTask;
let renderGeneration=0;
async function setPage(n){if(!pdf||!Number.isSafeInteger(n)||n<1||n>pdf.numPages)throw new Error("Ingrese una página válida entre 1 y "+(pdf?.numPages||1)+".");const generation=++renderGeneration;const previous=renderTask;if(previous){previous.cancel();try{await previous.promise;}catch(e){if(e?.name!=="RenderingCancelledException")throw e;}if(renderTask===previous)renderTask=undefined;}if(generation!==renderGeneration)return;current=n;pageInput.value=String(current);pageInput.max=String(pdf.numPages);location.hash="page="+current;prev.disabled=current<=1;next.disabled=current>=pdf.numPages;const page=await pdf.getPage(current);if(generation!==renderGeneration)return;const base=page.getViewport({scale:1}),scale=Math.max(.1,(document.querySelector("main").clientWidth-32)/base.width),viewport=page.getViewport({scale}),ratio=Math.min(2,window.devicePixelRatio||1);canvas.width=Math.floor(viewport.width*ratio);canvas.height=Math.floor(viewport.height*ratio);canvas.style.width=viewport.width+"px";canvas.style.height=viewport.height+"px";const ctx=canvas.getContext("2d");ctx.setTransform(ratio,0,0,ratio,0,0);const task=page.render({canvasContext:ctx,viewport});renderTask=task;try{await task.promise;}finally{if(renderTask===task)renderTask=undefined;}}
function handleRenderError(e){if(e?.name==="RenderingCancelledException")return;status.textContent=e?.message||"No fue posible mostrar esta página. Puede descargar el original.";retry.hidden=false;}
async function goToPage(n){try{await setPage(n);if(n===current){status.textContent="Fuente del expediente · PDF de solo lectura";retry.hidden=true;}}catch(e){handleRenderError(e);}}
async function start(){try{retry.hidden=true;status.textContent="Cargando documento…";const response=await fetch("${sourcePath}",{credentials:"same-origin",cache:"no-store"});if(!response.ok)throw new Error(response.status===404?"El enlace expiró o la fuente ya no está disponible. Vuelva al chat y abra la cita otra vez.":"No fue posible abrir la fuente.");const data=new Uint8Array(await response.arrayBuffer());pdf=await pdfjsLib.getDocument({data,isEvalSupported:false,enableXfa:false,disableAutoFetch:true,disableStream:true,useWasm:true,wasmUrl:"${modulePath}/wasm/",useSystemFonts:true,standardFontDataUrl:"${modulePath}/standard_fonts/",cMapUrl:"${modulePath}/cmaps/",cMapPacked:true}).promise;total.textContent=String(pdf.numPages);pageInput.max=String(pdf.numPages);const requested=Number(new URLSearchParams(location.hash.slice(1)).get("page"));if(Number.isSafeInteger(requested)&&requested>pdf.numPages){pageInput.value=String(requested);status.textContent="La cita apunta a la página "+requested+", pero el PDF tiene "+pdf.numPages+" páginas. Ingrese una página válida o descargue el original.";prev.disabled=true;next.disabled=true;return;}await setPage(Number.isSafeInteger(requested)&&requested>0?requested:1);status.textContent="Fuente del expediente · PDF de solo lectura";}catch(e){status.textContent=(e&&e.message)||"No fue posible mostrar el PDF. Puede descargar el original.";retry.hidden=false;}}
prev.addEventListener("click",()=>goToPage(current-1));next.addEventListener("click",()=>goToPage(current+1));pageInput.addEventListener("change",()=>{const n=Number(pageInput.value);if(Number.isSafeInteger(n)&&pdf&&n>=1&&n<=pdf.numPages)goToPage(n);else if(pdf)status.textContent="Ingrese un número de página entre 1 y "+pdf.numPages+". Puede descargar el original.";});retry.addEventListener("click",start);window.addEventListener("resize",()=>pdf&&current>=1&&current<=pdf.numPages&&goToPage(current));start();
</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; style-src 'nonce-${nonce}'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'`,
    },
  });
}
