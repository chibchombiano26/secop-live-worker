import { z } from 'zod/v4';
export const PRIVATE_SCOPES = ['dossier:read','dossier:write','company:write','conversation:write'] as const;
export const scopeSchema = z.enum(PRIVATE_SCOPES);
export const privateContextSchema = z.object({ ownerId:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),scopes:z.array(scopeSchema).min(1)}).strict();
export type PrivateContext = z.infer<typeof privateContextSchema>;
export class DossierError extends Error {
 constructor(public code:string,public status=400,public retryable=false){super(code);this.name='DossierError';}
}
export type PrivateAuthEnv = { PRIVATE_AUTH_PEPPER?:string; PRIVATE_CONNECTIONS?:string };
