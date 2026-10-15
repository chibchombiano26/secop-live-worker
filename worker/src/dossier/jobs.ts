import { DossierError, PRIVATE_SCOPES } from './contracts';
import { DossierRepository, type DossierEnv, type Job } from './repository';
export async function dispatchJobs(env:DossierEnv,now=Date.now()){
 if(!env.DOSSIER_DB||!env.DOSSIER_QUEUE)return;
 await env.DOSSIER_DB.prepare("UPDATE dossier_jobs SET state='failed',error='RETRY_LIMIT',lease=NULL,lease_until=NULL WHERE state='running' AND attempts>=5 AND lease_until<=?").bind(now).run();
 const rows=await env.DOSSIER_DB.prepare("SELECT owner_id AS ownerId,id AS jobId FROM dossier_jobs WHERE attempts<5 AND ((state='queued' AND available_at<=? AND (dispatched_at IS NULL OR dispatched_at<=?)) OR (state='running' AND lease_until<=?)) ORDER BY created_at LIMIT 100").bind(now,now-60000,now).all<{ownerId:string;jobId:string}>();
 for(const item of rows.results){await env.DOSSIER_QUEUE.send(item);await env.DOSSIER_DB.prepare('UPDATE dossier_jobs SET dispatched_at=? WHERE owner_id=? AND id=?').bind(now,item.ownerId,item.jobId).run();}
}
export async function processJob(env:DossierEnv,message:{ownerId:string;jobId:string},execute:(repo:DossierRepository,job:Job)=>Promise<void>){
 const repo=new DossierRepository(env,{ownerId:message.ownerId,scopes:[...PRIVATE_SCOPES]});
 const job=await repo.claimJob(message.jobId);if(!job)return;
 try{await execute(repo,job);await repo.completeJob(job.id,job.lease!);}catch(error){
 const failure=error instanceof DossierError?error:new DossierError('PROCESSING_FAILED',502,true);
 if(failure.code==='LEASE_LOST')return;
 await repo.failJob(job.id,job.lease!,failure.code,failure.retryable);
 }
}
