import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync} from 'node:fs';
import {DossierRepository} from '../src/dossier/repository';
import {createUploadTicket,acceptUploadTicket} from '../src/dossier/uploads';
let mf:Miniflare,env:any,repo:DossierRepository;let now=1000000;
beforeAll(async()=>{mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DOSSIER_DB'],r2Buckets:['DOSSIER_FILES'],compatibilityDate:'2026-10-01'}));env={DOSSIER_DB:await mf.getD1Database('DOSSIER_DB'),DOSSIER_FILES:await mf.getR2Bucket('DOSSIER_FILES')};await env.DOSSIER_DB.exec(readFileSync(new URL('../migrations/0001_dossiers.sql',import.meta.url),'utf8'));repo=new DossierRepository(env,{ownerId:'a',scopes:['dossier:write','company:write']},()=>now);await repo.createOrGetDossier('CO1.REQ.1');await repo.save('document','doc',{name:'Original.pdf',dossierId:'CO1.REQ.1',corpusRevision:1,state:'blocked',url:null},0);});afterAll(async()=>mf?.dispose());
describe('protected upload tickets',()=>{
 it('binds one validated upload to its owner and blocked item and prevents reuse',async()=>{
 const ticket=await createUploadTicket(repo,{documentId:'doc'});const bytes=new TextEncoder().encode('%PDF-1.7 actual manual upload');
 await expect(acceptUploadTicket(env,ticket.token.replace(/^a\./,'b.'),'manual.pdf',bytes,now)).rejects.toThrow();
 const result=await acceptUploadTicket(env,ticket.token,'manual.pdf',bytes,now);expect(result.documentId).not.toBe('doc');
 expect((await repo.read<any>('document',result.documentId)).value.replacesDocumentId).toBe('doc');
 await expect(acceptUploadTicket(env,ticket.token,'manual.pdf',bytes,now)).rejects.toThrow();
 });
 it('expires tickets and rejects invalid bytes before consumption',async()=>{
 const ticket=await createUploadTicket(repo,{documentId:'doc'});
 await expect(acceptUploadTicket(env,ticket.token,'manual.pdf',new TextEncoder().encode('HTML'),now)).rejects.toThrow('UNSUPPORTED_DOCUMENT');
 await expect(acceptUploadTicket(env,ticket.token,'manual.pdf',new TextEncoder().encode('%PDF-1.7 data'),now+600001)).rejects.toThrow('UPLOAD_TICKET_INVALID');
 });
});
