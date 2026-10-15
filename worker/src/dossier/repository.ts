import { DossierError, type PrivateContext } from './contracts';
export type DossierEnv = {DOSSIER_DB?:D1Database;DOSSIER_FILES?:R2Bucket;DOSSIER_QUEUE?:Queue<{ownerId:string;jobId:string}>};
export type EntityKind='dossier'|'document'|'chunk'|'report'|'requirement'|'company'|'evidence'|'assessment'|'review'|'task'|'conversation'|'upload';
export type Stored<T>={id:string;revision:number;value:T;updatedAt:number};
export type Job={id:string;kind:'inventory'|'extract'|'synthesize'|'assess';targetId:string;state:'queued'|'running'|'succeeded'|'failed'|'cancelled';attempts:number;lease:string|null;leaseUntil:number|null;progress:Record<string,unknown>;error:string|null};
const jobColumns='id,kind,target_id AS targetId,state,attempts,lease,lease_until AS leaseUntil,progress,error';
export class DossierRepository {
 readonly db:D1Database;readonly bucket:R2Bucket;
 constructor(readonly env:DossierEnv,readonly context:PrivateContext,readonly now:()=>number=Date.now){
 if(!env.DOSSIER_DB||!env.DOSSIER_FILES)throw new DossierError('DOSSIER_UNCONFIGURED',503);
 this.db=env.DOSSIER_DB;this.bucket=env.DOSSIER_FILES;
 }
 async read<T>(kind:EntityKind,id:string):Promise<Stored<T>>{
 const row=await this.db.prepare('SELECT id,revision,value,updated_at AS updatedAt FROM dossier_records WHERE owner_id=? AND kind=? AND id=?').bind(this.context.ownerId,kind,id).first<{id:string;revision:number;value:string;updatedAt:number}>();
 if(!row)throw new DossierError('NOT_FOUND',404);return {...row,value:JSON.parse(row.value) as T};
 }
 async list<T>(kind:EntityKind,offset=0,limit=100):Promise<Stored<T>[]>{
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>200)throw new DossierError('INVALID_PAGE');
 const rows=await this.db.prepare('SELECT id,revision,value,updated_at AS updatedAt FROM dossier_records WHERE owner_id=? AND kind=? ORDER BY id LIMIT ? OFFSET ?').bind(this.context.ownerId,kind,limit,offset).all<{id:string;revision:number;value:string;updatedAt:number}>();return rows.results.map(r=>({...r,value:JSON.parse(r.value) as T}));
 }
 async all<T>(kind:EntityKind):Promise<Stored<T>[]>{const rows:Stored<T>[]=[];for(let page=0;;page+=200){const items=await this.list<T>(kind,page,200);rows.push(...items);if(items.length<200)return rows;if(rows.length>=50000)throw new DossierError('RESOURCE_LIMIT',413);}}
 async save<T>(kind:EntityKind,id:string,value:T,expectedRevision:number):Promise<Stored<T>>{
 const serialized=JSON.stringify(value);if(serialized.length>500000)throw new DossierError('RECORD_TOO_LARGE',413);
 const result=expectedRevision===0?await this.db.prepare('INSERT INTO dossier_records(owner_id,kind,id,revision,value,updated_at) VALUES(?,?,?,1,?,?) ON CONFLICT DO NOTHING').bind(this.context.ownerId,kind,id,serialized,this.now()).run():await this.db.prepare('UPDATE dossier_records SET value=?,revision=revision+1,updated_at=? WHERE owner_id=? AND kind=? AND id=? AND revision=?').bind(serialized,this.now(),this.context.ownerId,kind,id,expectedRevision).run();
 if(result.meta.changes!==1)throw new DossierError('REVISION_CONFLICT',409);return this.read<T>(kind,id);
 }
 async upsert<T>(kind:EntityKind,id:string,value:T){let revision=0;try{revision=(await this.read(kind,id)).revision;}catch(e){if(!(e instanceof DossierError)||e.code!=='NOT_FOUND')throw e;}return this.save(kind,id,value,revision);}
 async createOrGetDossier(processId:string){
 if(!/^CO1\.REQ\.\d+$/.test(processId))throw new DossierError('INVALID_PROCESS');
 try{return await this.read<Record<string,unknown>>('dossier',processId);}catch(e){if(!(e instanceof DossierError)||e.code!=='NOT_FOUND')throw e;}
 try{return await this.save('dossier',processId,{processId,corpusRevision:0,state:'new',coverage:{inventoryComplete:false},description:null},0);}catch(e){if(e instanceof DossierError&&e.code==='REVISION_CONFLICT')return this.read<Record<string,unknown>>('dossier',processId);throw e;}
 }
 readDossier(id:string){return this.read<Record<string,unknown>>('dossier',id);}
 private fileKey(id:string){if(!/^[A-Za-z0-9._-]{1,200}$/.test(id))throw new DossierError('INVALID_FILE');return `${this.context.ownerId}/${id}`;}
 async putFile(id:string,bytes:Uint8Array,mime:string){await this.bucket.put(this.fileKey(id),bytes,{httpMetadata:{contentType:mime}});}
 getFile(id:string){return this.bucket.get(this.fileKey(id));}
 async deleteFile(id:string){await this.bucket.delete(this.fileKey(id));}
 async enqueueJob(input:{kind:Job['kind'];targetId:string;key:string}){
 const id=crypto.randomUUID();await this.db.prepare("INSERT INTO dossier_jobs(owner_id,id,kind,target_id,idempotency_key,state,available_at,created_at) VALUES(?,?,?,?,?,'queued',?,?) ON CONFLICT DO NOTHING").bind(this.context.ownerId,id,input.kind,input.targetId,input.key,this.now(),this.now()).run();
 const row=await this.db.prepare(`SELECT ${jobColumns} FROM dossier_jobs WHERE owner_id=? AND idempotency_key=?`).bind(this.context.ownerId,input.key).first();if(!row)throw new DossierError('JOB_CREATE_FAILED',503);return this.parseJob(row);
 }
 private parseJob(row:Record<string,unknown>):Job{return {...row,progress:JSON.parse(String(row.progress))} as Job;}
 async readJob(id:string){const row=await this.db.prepare(`SELECT ${jobColumns} FROM dossier_jobs WHERE owner_id=? AND id=?`).bind(this.context.ownerId,id).first();if(!row)throw new DossierError('NOT_FOUND',404);return this.parseJob(row);}
 async listDispatchableJobs(){const rows=await this.db.prepare(`SELECT ${jobColumns} FROM dossier_jobs WHERE owner_id=? AND attempts<5 AND ((state='queued' AND available_at<=?) OR (state='running' AND lease_until<=?)) ORDER BY created_at LIMIT 100`).bind(this.context.ownerId,this.now(),this.now()).all();return rows.results.map(r=>this.parseJob(r));}
 async claimJob(id:string){const lease=crypto.randomUUID();const res=await this.db.prepare("UPDATE dossier_jobs SET state='running',lease=?,lease_until=?,attempts=attempts+1 WHERE owner_id=? AND id=? AND attempts<5 AND ((state='queued' AND available_at<=?) OR (state='running' AND lease_until<=?))").bind(lease,this.now()+120000,this.context.ownerId,id,this.now(),this.now()).run();return res.meta.changes===1?this.readJob(id):null;}
 async checkpointJob(id:string,lease:string,progress:Record<string,unknown>){const res=await this.db.prepare("UPDATE dossier_jobs SET progress=?,lease_until=? WHERE owner_id=? AND id=? AND state='running' AND lease=? AND lease_until>?").bind(JSON.stringify(progress),this.now()+120000,this.context.ownerId,id,lease,this.now()).run();if(res.meta.changes!==1)throw new DossierError('LEASE_LOST',409);}
 async completeJob(id:string,lease:string){const res=await this.db.prepare("UPDATE dossier_jobs SET state='succeeded',lease=NULL,lease_until=NULL WHERE owner_id=? AND id=? AND state='running' AND lease=? AND lease_until>?").bind(this.context.ownerId,id,lease,this.now()).run();if(res.meta.changes!==1)throw new DossierError('LEASE_LOST',409);}
 async failJob(id:string,lease:string,code:string,retryable:boolean){const job=await this.readJob(id);const retry=retryable&&job.attempts<5;const res=await this.db.prepare("UPDATE dossier_jobs SET state=?,error=?,available_at=?,lease=NULL,lease_until=NULL,dispatched_at=NULL WHERE owner_id=? AND id=? AND state='running' AND lease=? AND lease_until>?").bind(retry?'queued':'failed',code,this.now()+Math.min(60000,1000*2**job.attempts),this.context.ownerId,id,lease,this.now()).run();if(res.meta.changes!==1)throw new DossierError('LEASE_LOST',409);}
 async cancelJob(id:string){await this.readJob(id);await this.db.prepare("UPDATE dossier_jobs SET state='cancelled',lease=NULL,lease_until=NULL WHERE owner_id=? AND id=? AND state IN ('queued','running')").bind(this.context.ownerId,id).run();}
}
