import { DossierError } from "./contracts";
import { DossierRepository, type DossierEnv } from "./repository";
import { identifyDocument, sha256 } from "./downloads";
import type { DocumentVersion } from "./inventory";
type Ticket = {
  hash: string;
  expiresAt: number;
  used: boolean;
  documentId?: string;
  companyId?: string;
  expiresOn?: string;
};
export async function createUploadTicket(
  repo: DossierRepository,
  input: { documentId?: string; companyId?: string; expiresOn?: string },
) {
  if (Boolean(input.documentId) === Boolean(input.companyId))
    throw new DossierError("UPLOAD_TARGET_REQUIRED");
  if (input.documentId) await repo.read("document", input.documentId);
  if (input.companyId) await repo.read("company", input.companyId);
  const id = crypto.randomUUID(),
    secret = crypto.randomUUID() + crypto.randomUUID();
  const expiresAt = repo.now() + 600000;
  await repo.save<Ticket>(
    "upload",
    id,
    { ...input, hash: await sha256(secret), expiresAt, used: false },
    0,
  );
  return { token: `${repo.context.ownerId}.${id}.${secret}`, expiresAt };
}
export async function acceptUploadTicket(
  env: DossierEnv,
  token: string,
  filename: string,
  bytes: Uint8Array,
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
    throw new DossierError("UPLOAD_TICKET_INVALID", 401);
  if (!filename || filename.length > 200 || /[\x00-\x1f/\\]/.test(filename))
    throw new DossierError("INVALID_FILENAME");
  if (!bytes.length || bytes.length > 25 * 1024 * 1024)
    throw new DossierError("DOCUMENT_TOO_LARGE", 413);
  const mime = identifyDocument(bytes);
  const repo = new DossierRepository(
    env,
    { ownerId, scopes: ["company:write", "dossier:write"] },
    () => now,
  );
  let ticket;
  try {
    ticket = await repo.read<Ticket>("upload", id);
  } catch {
    throw new DossierError("UPLOAD_TICKET_INVALID", 401);
  }
  if (
    ticket.value.used ||
    ticket.value.expiresAt <= now ||
    ticket.value.hash !== (await sha256(secret))
  )
    throw new DossierError("UPLOAD_TICKET_INVALID", 401);
  const original = ticket.value.documentId
    ? await repo.read<DocumentVersion>("document", ticket.value.documentId)
    : null;
  const profile = ticket.value.companyId
    ? await repo.read("company", ticket.value.companyId)
    : null;
  await repo.save(
    "upload",
    id,
    { ...ticket.value, used: true },
    ticket.revision,
  );
  const documentId = crypto.randomUUID();
  await repo.putFile(documentId, bytes, mime);
  await repo.save(
    "document",
    documentId,
    {
      name: filename,
      sourceId: documentId,
      processId: original?.value.processId ?? "",
      url: null,
      dossierId: original?.value.dossierId ?? `company:${profile!.id}`,
      corpusRevision: original
        ? original.value.corpusRevision + 1
        : profile!.revision,
      state: "pending",
      fileId: documentId,
      originalSavedAt: repo.now(),
      hash: await sha256(bytes),
      provenance: "manual",
      replacesDocumentId: original?.id,
      expiresOn: ticket.value.expiresOn,
    },
    0,
  );
  if (original) {
    const dossier = await repo.readDossier(original.value.dossierId);
    const ids = ((dossier.value.documentIds ?? []) as string[]).map((x) =>
      x === original.id ? documentId : x,
    );
    await repo.save(
      "dossier",
      dossier.id,
      {
        ...dossier.value,
        documentIds: ids,
        corpusRevision: Number(dossier.value.corpusRevision ?? 0) + 1,
        state: "processing",
        needsSynthesis: true,
      },
      dossier.revision,
    );
  }
  if (profile) {
    await repo.save(
      "evidence",
      documentId,
      {
        companyId: profile.id,
        documentId,
        expiresOn: ticket.value.expiresOn,
        provenance: "manual",
      },
      0,
    );
    await repo.save(
      "company",
      profile.id,
      { ...(profile.value as Record<string, unknown>), evidenceChangedAt: now },
      profile.revision,
    );
  }
  await repo.enqueueJob({
    kind: "extract",
    targetId: documentId,
    key: `extract:${documentId}`,
  });
  return { documentId, state: "pending" };
}
export function uploadPage() {
  const nonce = crypto.randomUUID();
  return new Response(
    `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Documento del expediente SECOP</title><style>body{font:16px/1.5 system-ui;max-width:38rem;margin:3rem auto;padding:1rem;color:#123}label,input,button{display:block;margin:1rem 0}button{padding:.8rem 1rem}input{max-width:100%}</style><h1>Agregar documento al expediente</h1><p>Este archivo se guardará en tu conexión privada y se procesará con el proveedor configurado. Máximo 25 MB. El enlace caduca en 10 minutos y admite una carga.</p><form><label for="file">Documento</label><input id="file" type="file" required accept=".pdf,.docx,.xlsx,.zip"><button>Guardar y procesar</button></form><p role="status" id="status"></p><script nonce="${nonce}">const ticket=new URLSearchParams(location.hash.slice(1)).get('ticket');history.replaceState(null,'',location.pathname);const form=document.querySelector('form'),status=document.querySelector('#status');form.onsubmit=async e=>{e.preventDefault();const file=document.querySelector('#file').files[0];if(!ticket||!file){status.textContent='Enlace inválido. Crea otro desde Savia.';return;}form.querySelector('button').disabled=true;try{const r=await fetch('/private/upload',{method:'POST',headers:{'X-Upload-Ticket':ticket,'X-Filename':encodeURIComponent(file.name),'Content-Type':'application/octet-stream'},body:file});const data=await r.json();if(!r.ok)throw new Error(data.error?.code||'Carga fallida');status.textContent='Archivo guardado. Puedes regresar a Savia para ver el progreso.';form.hidden=true;}catch(e){status.textContent='No se pudo completar: '+e.message+'. Crea un nuevo enlace para reintentar.';form.querySelector('button').disabled=false;}};</script></html>`,
    {
      headers: {
        "content-type": "text/html;charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
      },
    },
  );
}
