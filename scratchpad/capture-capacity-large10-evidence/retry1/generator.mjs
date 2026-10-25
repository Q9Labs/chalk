import { readFile,writeFile,mkdir,access,unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { launchGuests,stats } from './scripts/prod-proof/media-capacity.mjs';
import { generateVoice } from './scripts/prod-proof/fixture.mjs';
import { request,save,waitFor } from './scripts/prod-proof/runtime.mjs';
const config=JSON.parse(await readFile('/opt/capacity/private-config.json','utf8'));
const spec=JSON.parse(await readFile('/opt/capacity/run-request.json','utf8'));
const nativeFetch=globalThis.fetch;
const {execFile}=await import('node:child_process');
const {promisify}=await import('node:util');
const exec=promisify(execFile);
let cleaning=false, freezeDetected=false, checks=0;
async function freeze(){
 if(!cleaning&&(stop||await check()||Date.now()>Number(spec.loadDeadlineMs??Infinity)))throw Error("load stopped before mutation");
 const id=randomUUID(),base='/opt/capacity/guard/'+id;await mkdir('/opt/capacity/guard',{recursive:true});await writeFile(base+'.request','');
 let proof;const until=Date.now()+30000;
 for(;;){if(!cleaning&&(stop||await check()))throw Error('load stopped during guard wait');try{proof=JSON.parse(await readFile(base+'.response','utf8'));break}catch(e){if(e.code!=='ENOENT')throw e;if(Date.now()>until)throw Error('guard response timeout');await delay(200);}}
 await unlink(base+'.response');if(!cleaning&&(stop||await check()))throw Error('load stopped before guarded mutation');if(!proof.idle)throw Error('live guard not idle');
 await writeFile('/opt/capacity/freeze-'+checks+++'.json',JSON.stringify(proof));
}
globalThis.capacityFreeze=freeze;
globalThis.capacityAssertRunning=async()=>{if(stop||await check())throw Error("load stopped during guest readiness")};
globalThis.fetch=async(input,init)=>{
 const url=typeof input==='string'?input:input.url??String(input);
 if(url.startsWith(config.api_url)&&!['GET','HEAD'].includes(init?.method??input.method??'GET'))await freeze();
 return nativeFetch(input,init);
};
const directory='/opt/capacity/results/'+spec.label;await mkdir(directory,{recursive:true,mode:0o700});
const controller=new AbortController();let stop=false;process.on('SIGTERM',()=>{stop=true});process.on('SIGINT',()=>{stop=true});
const runs=[];
const check=async()=>{try{await access('/opt/capacity/stop');return true}catch{return false}};
try{
 const speech=await generateVoice(directory,controller.signal);
 for(let i=0;i<spec.count;i++){
  if(stop||await check())throw Error("load stopped during setup");
  const run={config:{...config,guests:spec.guests},apiKey:config.apiKey,directory:directory+'/'+i,signal:controller.signal,resources:[],cleanup:[],wait:delay};await mkdir(run.directory,{recursive:true});runs.push(run);run.tenantPath='/v1/tenants/'+config.tenant_id;run.apiRequest=(method,path,body)=>request(run.config,method,path,body,{Authorization:'Bearer '+config.apiKey});run.ownerRequest=run.apiRequest;
  const space=spec.shared?.space??await run.apiRequest('POST',run.tenantPath+'/spaces',{name:'Capture capacity v2 rerun',slug:'capture-v2-'+randomUUID(),media_plane:'cf_sfu',recording_policy:'manual',transcription_policy:'on_demand',default_episode_duration_seconds:1800,maximum_episode_duration_seconds:1800,linger_window_seconds:60,admission_policy:{mode:'open'}});run.space=space;if(!spec.shared)run.resources.push({kind:'space',dispose:()=>run.apiRequest('POST',run.tenantPath+'/spaces/'+space.id+'/archive',{})});
  const path=run.tenantPath+'/spaces/'+space.id+'/episodes';const episode=spec.shared?.episode??await run.apiRequest('POST',path,{});run.episode=episode;await save(run.directory+'/resource-ids.json',{space_id:space.id,episode_id:episode.id});if(!spec.shared)run.resources.push({kind:'episode',dispose:()=>run.apiRequest('POST',path+'/'+episode.id+'/end',{})});
  if(!spec.shared)await save(directory+'/created.json',{space,episode});
  const {pages}=await launchGuests(run,space,episode,speech,'https://nightly.chalkmeet.com/capacity-proof',false,spec.guests,spec.totalGuests??spec.guests,spec.guestOffset??0);run.pages=pages;
  if(spec.preflight||spec.shared){run.recordingId='preflight';continue;}
  if(stop||await check())throw Error("load stopped before Recording start");
  const started=await pages[0].evaluate(()=>window.proofClient.recording.start());run.recordingId=started.recordingId;await save(run.directory+'/recording-id.json',{recording_id:run.recordingId});
  await waitFor('capture ready',async()=>{if(stop||await check())throw Error('load stopped during readiness');const s=await pages[0].evaluate(()=>window.proofClient.getSnapshot().recording.current);return s?.status==='recording'&&s?.recordingId===run.recordingId},120000);
  console.log(JSON.stringify({event:'recording-ready',recording_id:run.recordingId}));
 }
 const ready={at:Date.now(),recordings:runs.map(r=>({recording_id:r.recordingId,space_id:r.space.id,episode_id:r.episode.id}))};await save(directory+'/ready.json',ready);await save('/opt/capacity/ready.json',ready);console.log('READY');
 const until=Date.now()+(spec.seconds??240)*1000;let index=0;
 while(!stop&&Date.now()<until&&!(await check())){
  const data=await Promise.all(runs.map(async r=>({recording_id:r.recordingId,guests:await stats(r.pages),recording:await r.pages[0].evaluate(()=>window.proofClient.getSnapshot().recording.current)})));
  await save(directory+'/stats-'+index+++'.json',{at:Date.now(),data});await delay(1000);
 }
}catch(e){await save(directory+'/error.json',{message:e.message});console.error(e.message);process.exitCode=1}
finally{
 cleaning=true;
 for(const run of runs)for(const page of run.pages??[])await page.close().catch(()=>{});
 for(const run of runs.reverse()){
  // Existing permanent key is never revoked by this harness.
  run.ownerRequest=async(method,path,body)=>request(run.config,method,path,body,{Authorization:'Bearer '+config.apiKey});
  const ordered=[...run.resources.filter(x=>x.kind==='episode'),...run.resources.filter(x=>x.kind!=='episode').reverse()];for(const resource of ordered){try{await resource.dispose();
 if(resource.kind==='episode'&&!spec.preflight&&run.recordingId){
  let exportRequested=false;
  await waitFor('sequential Capture and Render finalization',async()=>{
   const state=await run.apiRequest('GET',run.tenantPath+'/recordings/'+run.recordingId);await save(run.directory+'/final-recording.json',state);
   if(['failed','expired'].includes(state.source.status))throw Error('Capture source '+state.source.status);
   if(state.export.status==='failed')throw Error('Render '+state.export.status);
   if(state.source.status!=='available')return false;
   if(!exportRequested&&state.export.status==='none'){await run.apiRequest('POST',run.tenantPath+'/recordings/'+run.recordingId+'/export',{});exportRequested=true;}
   return state.source.status==='available'&&state.export.status==='ready'?state:false;
  },480000);
  const download=await run.apiRequest('POST',run.tenantPath+'/recordings/'+run.recordingId+'/download-url',{expires_in_seconds:300});
  const probe=await exec('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,codec_name,width,height','-of','json',download.url],{timeout:90000,maxBuffer:1048576});
  const media=JSON.parse(probe.stdout);if(!(Number(media.format?.duration)>0)||!media.streams?.some(s=>s.codec_type==='video'))throw Error('unplayable export metadata');
  await exec('ffmpeg',['-v','error','-i',download.url,'-t','3','-f','null','-'],{timeout:90000,maxBuffer:1048576});
  await save(run.directory+'/playable.json',{recording_id:run.recordingId,decoded_seconds:3,...media});
 }
 run.cleanup.push({kind:resource.kind,result:'passed'})}catch(e){run.cleanup.push({kind:resource.kind,result:'failed',message:e.message});process.exitCode=1}}await save(run.directory+'/cleanup.json',run.cleanup);
 }
 await save(directory+'/finished.json',{at:Date.now(),freezeDetected,freezeChecks:checks});
}
