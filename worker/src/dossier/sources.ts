import { DossierError } from "./contracts";
import { sha256 } from "./downloads";
import { DossierRepository, type DossierEnv } from "./repository";
import type { DocumentVersion } from "./inventory";

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
    page?: number;
  },
) {
  const document = await repo.read<DocumentVersion>("document", input.documentId);
  if (!(await hasStoredPdf(repo, document.value, input.dossierId)))
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
      fileId: document.value.fileId!,
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

export async function readSourceTicket(
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
  const file = await repo.getFile(ticket.value.fileId);
  if (!file) throw invalidTicket();
  const headers = new Headers({
    "Content-Type": "application/pdf",
    "Content-Disposition": 'inline; filename="source.pdf"',
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  if (file.size !== undefined) headers.set("Content-Length", String(file.size));
  return new Response(file.body, { status: 200, headers });
}
