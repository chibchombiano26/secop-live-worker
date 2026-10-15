import { z } from 'zod/v4';
import { unzipSync } from 'fflate';
import { DossierError } from './contracts';
import { boundedBytes, downloadOfficialDocument, identifyDocument, sha256 } from './downloads';
import { DossierRepository } from './repository';
import type { DocumentVersion } from './inventory';
const resultSchema=z.object({parserVersion:z.string().min(1).max(100),pages:z.array(z.object({page:z.number().int().positive().optional(),section:z.string().max(500).optional(),text:z.string().max(2000000)})).max(10000),warnings:z.array(z.string().max(500)).max(100),complete:z.boolean()});
export type ExtractionResult=z.infer<typeof resultSchema>;
export type EvidenceChunk={documentVersionId:string;page?:number;section?:string;text:string;index:number};
export type ExtractionFile={name:string;mime:string;bytes:Uint8Array};
export interface ExtractionProvider{extract(file:ExtractionFile,signal:AbortSignal):Promise<ExtractionResult>}
export function normalizeExtraction(value:unknown):ExtractionResult{
 const result=resultSchema.parse(value);if(!result.complete)throw new DossierError('EXTRACTION_INCOMPLETE',409);
 if(!result.pages.some(p=>p.text.trim().length>10))throw new DossierError('OCR_REQUIRED',409);
 if(result.pages.reduce((n,p)=>n+p.text.length,0)>8000000)throw new DossierError('EXTRACTION_TOO_LARGE',413);
 if(result.pages.some(p=>!p.text.trim()))result.warnings.push('EMPTY_PAGES_REQUIRE_OCR');
 return result;
}
export function splitEvidence(result:ExtractionResult,documentVersionId:string):EvidenceChunk[]{
 const chunks:EvidenceChunk[]=[];for(const page of result.pages){for(let pos=0;pos<page.text.length;pos+=3500){const text=page.text.slice(pos,pos+4000);if(text.trim())chunks.push({documentVersionId,...(page.page?{page:page.page}:{}),section:page.section,text,index:chunks.length});}}return chunks;
}
export function inspectArchive(bytes:Uint8Array,limits:{maxEntries?:number;maxExpandedBytes?:number}={}){
 let count=0,total=0;const entries:Record<string,Uint8Array>={};const maxEntries=limits.maxEntries??100,maxBytes=limits.maxExpandedBytes??100*1024*1024;
 function visit(data:Uint8Array,depth:number,prefix=''){
 let values:Record<string,Uint8Array>;
 try{values=unzipSync(data,{filter:file=>{
 count++;if(count>maxEntries)throw new DossierError('ARCHIVE_LIMIT',413);
 if(file.name.includes('\\')||file.name.startsWith('/')||file.name.split('/').some(x=>x==='..')||/[\x00-\x1f]/.test(file.name))throw new DossierError('UNSAFE_ARCHIVE');
 total+=file.originalSize;if(total>maxBytes||file.originalSize<0)throw new DossierError('ARCHIVE_LIMIT',413);return true;
 }});}catch(e){if(e instanceof DossierError)throw e;throw new DossierError('ENCRYPTED_OR_INVALID_ARCHIVE',415);}
 for(const [name,value] of Object.entries(values)){if(value.length>maxBytes)throw new DossierError('ARCHIVE_LIMIT',413);if(name.endsWith('/'))continue;
 if(/\.zip$/i.test(name)){if(depth>=1)throw new DossierError('ARCHIVE_LIMIT',413);visit(value,depth+1,`${prefix}${name}/`);}else entries[`${prefix}${name}`]=value;}
 }
 visit(bytes,0);return entries;
}
export class HttpExtractionProvider implements ExtractionProvider{
 constructor(readonly env:{EXTRACTOR_URL?:string;EXTRACTOR_KEY?:string},readonly fetcher:typeof fetch=fetch){}
 async extract(file:ExtractionFile,signal:AbortSignal){let endpoint:URL;try{endpoint=new URL(this.env.EXTRACTOR_URL??'');}catch{throw new DossierError('EXTRACTOR_UNCONFIGURED',503);}
 if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||!this.env.EXTRACTOR_KEY)throw new DossierError('EXTRACTOR_UNCONFIGURED',503);
 const form=new FormData();form.set('file',new Blob([Uint8Array.from(file.bytes).buffer],{type:file.mime}),file.name);form.set('options',JSON.stringify({ocr:true,complete:true,archiveLimits:{maxEntries:100,maxExpandedBytes:100*1024*1024,maxDepth:1}}));
 const response=await this.fetcher(endpoint,{method:'POST',headers:{Authorization:`Bearer ${this.env.EXTRACTOR_KEY}`},body:form,signal,redirect:'error'});
 if(!response.ok)throw new DossierError('EXTRACTOR_UNAVAILABLE',502,true);return normalizeExtraction(JSON.parse(new TextDecoder().decode(await boundedBytes(response,10*1024*1024))));
 }
}
export type MarkdownBinding={toMarkdown:(file:{name:string;blob:Blob})=>Promise<{format:string;data?:string;error?:string}>};
export class CloudflareExtractionProvider implements ExtractionProvider{
 constructor(readonly ai:MarkdownBinding){}
 async extract(file:ExtractionFile,signal:AbortSignal){signal.throwIfAborted();const result=await this.ai.toMarkdown({name:file.name,blob:new Blob([Uint8Array.from(file.bytes).buffer],{type:file.mime})});signal.throwIfAborted();
 if(result.format==='error'||!result.data)throw new DossierError('OCR_OR_FORMAT_UNAVAILABLE',409);
 // Only headings emitted by the parser establish page numbers. Other content uses sections.
 const sections=result.data.split(/(?=^### Page \d+\s*$)/m);const pages=sections.map((text,index)=>{const match=/^### Page (\d+)\s*\n/.exec(text);return {...(match?{page:Number(match[1])}:{section:`Extracted text ${index+1}`}),text:match?text.slice(match[0].length):text};});
 const usable=pages.filter(p=>p.text.trim()&&!/^# .*\n## Metadata\b/s.test(p.text));
 return normalizeExtraction({parserVersion:'cloudflare-tomarkdown-v1',pages:usable,warnings:['OCR_AND_SOURCE_COMPLETENESS_REQUIRE_REVIEW'],complete:true});
 }
}
async function extractBounded(file:ExtractionFile,provider:ExtractionProvider,signal:AbortSignal):Promise<ExtractionResult>{
 if(file.mime!=='application/zip')return normalizeExtraction(await provider.extract(file,signal));
 const entries=inspectArchive(file.bytes);
 const office=/\.(docx|xlsx)$/i.test(file.name);
 if(office)return normalizeExtraction(await provider.extract({...file,mime:file.name.toLowerCase().endsWith('.docx')?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},signal));
 const pages:ExtractionResult['pages']=[];const warnings:string[]=[];
 for(const [name,bytes] of Object.entries(entries)){
 try{const mime=identifyDocument(bytes);const result=await extractBounded({name,mime,bytes},provider,signal);pages.push(...result.pages.map(p=>({...p,section:`${name}${p.section?` / ${p.section}`:''}`})));warnings.push(...result.warnings);}catch(e){throw new DossierError(e instanceof DossierError?e.code:'ARCHIVE_MEMBER_UNSUPPORTED',409);}
 }return normalizeExtraction({pages,warnings,parserVersion:'bounded-archive-v1',complete:true});
}
export async function saveExtraction(repo:DossierRepository,documentVersionId:string,result:ExtractionResult){
 const doc=await repo.read<DocumentVersion>('document',documentVersionId);const chunks=splitEvidence(normalizeExtraction(result),documentVersionId);
 for(const chunk of chunks)await repo.upsert('chunk',`${documentVersionId}.${chunk.index}`,chunk);
 await repo.save('document',doc.id,{...doc.value,state:result.warnings.length?'review_required':'ready',parserVersion:result.parserVersion,warnings:result.warnings,chunkCount:chunks.length},doc.revision);
}
export async function extractDocument(repo:DossierRepository,id:string,provider:ExtractionProvider,checkpoint?:()=>Promise<void>){
 let doc=await repo.read<DocumentVersion>('document',id);if(['ready','review_required','removed','deleted'].includes(doc.value.state))return;
 try{let bytes:Uint8Array;let mime:string;
 if(doc.value.fileId){const original=await repo.getFile(doc.value.fileId);if(!original)throw new DossierError('ORIGINAL_MISSING',404);bytes=new Uint8Array(await original.arrayBuffer());mime=identifyDocument(bytes);}
 else{if(!doc.value.url)throw new DossierError('HUMAN_HELP_REQUIRED',409);const file=await downloadOfficialDocument(doc.value.url);bytes=file.bytes;mime=file.mime;await repo.putFile(id,bytes,mime);doc=await repo.save('document',id,{...doc.value,hash:file.hash,fileId:id},doc.revision);}
 await checkpoint?.();const hash=await sha256(bytes);const previous=(await repo.all<DocumentVersion>('document')).find(d=>d.id!==id&&d.value.hash===hash&&['ready','review_required'].includes(d.value.state));
 if(previous){const previousChunks=(await repo.all<EvidenceChunk>('chunk')).filter(c=>c.value.documentVersionId===previous.id);if(previousChunks.length){await saveExtraction(repo,id,{pages:previousChunks.map(c=>({page:c.value.page,section:c.value.section,text:c.value.text})),parserVersion:previous.value.parserVersion??'reused',warnings:previous.value.state==='review_required'?['REUSED_EXTRACTION_REQUIRES_REVIEW']:[],complete:true});return;}}
 const result=await extractBounded({name:doc.value.name,mime,bytes},provider,AbortSignal.timeout(90000));await checkpoint?.();await saveExtraction(repo,id,result);
 }catch(e){const error=e instanceof DossierError?e:new DossierError('EXTRACTION_FAILED',502,true);const current=await repo.read<DocumentVersion>('document',id);await repo.save('document',id,{...current.value,state:error.code==='HUMAN_HELP_REQUIRED'?'blocked':error.retryable?'pending':'failed',error:error.code},current.revision);throw error;}
}
