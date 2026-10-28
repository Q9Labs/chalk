import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { identityEnvironment } from '../../dev/identity.mjs';

const root = process.cwd(), task = process.env.CRASH_TASK_DIR;
const requireClient = createRequire(join(root, 'sdks/typescript/client/package.json'));
const { build } = requireClient('esbuild');
const { chromium } = requireClient('playwright');
const out = join(task, 'results'); await mkdir(out);
const apiURL = 'http://127.0.0.1:8080', token = randomUUID();
const children = [], servers = [], browsers = [];
const rows = [], events = [];
let active, asset;
function emit(event) { events.push({ at: new Date().toISOString(), ...event }); console.log(JSON.stringify(event)); }
async function request(path, body, method = 'POST') {
  const response = await fetch(apiURL + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0,500)}`);
  return JSON.parse(text);
}
function sql(query) { return execFileSync('docker', ['exec', 'chalk-tab-crash-pg', 'psql', '-U', 'postgres', '-d', 'chalk_crash', '-Atqc', query], { encoding: 'utf8' }).trim(); }
async function server(handler, port) {
  const instance = createServer(handler); instance.listen(port, '127.0.0.1'); await once(instance, 'listening'); servers.push(instance); return instance;
}
function child(command, args, env, logName, cwd = root) {
  const log = join(task, logName);
  const owner = "import ctypes,os,signal,sys; parent=os.getppid(); ctypes.CDLL(None).prctl(1,signal.SIGKILL); os.getppid()==parent or sys.exit(125); os.execvp(sys.argv[1],sys.argv[1:])";
  const proc = spawn('python3', ['-c', owner, command, ...args], { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = []; proc.stdout.on('data', data => chunks.push(data)); proc.stderr.on('data', data => chunks.push(data));
  proc.on('exit', () => writeFile(log, Buffer.concat(chunks))); children.push(proc); return proc;
}
async function ready(url, proc) {
  for (let n=0;n<180;n++) {
    if (proc.exitCode !== null) throw new Error(`service exited ${proc.exitCode}: ${url}`);
    try { if ((await fetch(url)).ok) return; } catch {}
    await delay(1000);
  }
  throw new Error(`not ready: ${url}`);
}
async function bundle(version) {
  const paths = {
    '@q9labsai/chalk-react': 'sdks/typescript/react/src/index.ts',
    '@q9labsai/chalk-client': 'sdks/typescript/client/src/index.ts',
    '@q9labsai/chalk-whiteboard': 'packages/whiteboard/src/index.ts',
    '@q9labsai/chalk-whiteboard/react': 'packages/whiteboard/src/react/index.ts',
    '@q9labsai/chalk-whiteboard/embedded': 'packages/whiteboard/src/embedded/index.ts',
    '@q9labsai/chalk-ui': 'packages/ui/src/index.ts',
    '@q9labsai/chalk-ui/reactions': 'packages/ui/src/reactions.ts',
    '@q9labsai/chalk-ui/assets': 'packages/ui/src/assets.ts',
    '@q9labsai/chalk-assets': 'packages/assets/src/index.ts',
    '@q9labsai/recording-presentation': 'packages/recording-presentation/src/index.ts',
    '@q9labsai/facehash': 'packages/facehash/src/index.ts',
    '@q9labsai/facehash/react': 'packages/facehash/src/react.ts',
  };
  const published = join(task,'published');
  const hostPlugin={name:'host-integration',setup(plugin){plugin.onResolve({filter:/^crash-host-whiteboard$/},()=>({path:process.env.CRASH_HOST_WHITEBOARD ?? join(root,'.private/crash-host-whiteboard.ts')}));}};
  const entry = join(version === '5.2.0' ? published : root, 'crash-entry.jsx');
  await writeFile(entry, await readFile(join(root,'scripts/research/tab-crash/page.jsx')));
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', target: 'chrome120', minify: true, sourcemap: 'inline',
    outdir: out, define: { 'process.env.NODE_ENV': '"production"' }, jsx: 'automatic',
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl' },
    nodePaths:[join(root,'sdks/typescript/react/node_modules')],
    plugins: [hostPlugin,...(version === '5.2.0' ? [] : [{ name:'workspace-source', setup(plugin) { plugin.onResolve({filter:/^@q9labsai\//}, args => paths[args.path] ? {path:join(root,paths[args.path])} : undefined); } }])],
  });
  asset = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
  return css;
}
async function rss(browserCDP) {
  const { processInfo } = await browserCDP.send('SystemInfo.getProcessInfo');
  const values = [];
  for (const info of processInfo) {
    try { const status = await readFile(`/proc/${info.id}/status`,'utf8'); values.push({pid:info.id,type:info.type,rssMiB:Number(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0)/1024,cgroup:await readFile(`/proc/${info.id}/cgroup`,'utf8')}); } catch {}
  }
  return { rendererRssMiB: values.filter(value=>value.type==='renderer').reduce((sum,value)=>sum+value.rssMiB,0), browserRssMiB:values.reduce((sum,value)=>sum+value.rssMiB,0),processes:values };
}
async function sample(page, cdp, browserCDP, label, run, cycle) {
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(metric=>[metric.name,metric.value]));
  const resources = await page.evaluate(()=>window.__resources());
  const state = await page.evaluate(()=>window.__state());
  const targets=await browserCDP.send('Target.getTargets');
  const memory=run.endsWith('-low')?{cgroupMiB:Number(await readFile('/sys/fs/cgroup/chalk-crash-browser/memory.current','utf8'))/1048576,cgroupPeakMiB:Number(await readFile('/sys/fs/cgroup/chalk-crash-browser/memory.peak','utf8'))/1048576}:{};
  const row = { run, cycle, label, elapsedSeconds:(Date.now()-runStart)/1000, heapMiB:metrics.JSHeapUsedSize/1048576, ...await rss(browserCDP), ...resources,
    ...memory,workerTargets:targets.targetInfos.filter(target=>target.type.includes('worker')).length,
    status:state.connection?.status, lastError:state.connection?.lastError?.code, errors:state.errors, grants:active.grants, forbidden:active.forbidden, blockedSockets:active.blockedSockets };
  rows.push(row); await writeFile(join(out,'measurements.json'),JSON.stringify(rows,null,2));
  emit({sample:run,cycle,label,heapMiB:row.heapMiB,rssMiB:row.rendererRssMiB,tracks:row.activeTracks,peers:row.openPeers,timers:row.timers,status:row.status,grants:row.grants,forbidden:row.forbidden});
  return row;
}
let runStart;
async function run(version, constrained) {
  const runName = `${version}-${constrained?'low':'normal'}`;
  const css = await bundle(version);
  const args = ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','--disable-dev-shm-usage'];
  if (constrained) args.push('--js-flags=--max-old-space-size=256','--renderer-process-limit=1');
  let executablePath=chromium.executablePath();
  if (constrained) {
    execFileSync('sudo',['mkdir','-p','/sys/fs/cgroup/chalk-crash-browser']);
    execFileSync('sudo',['tee','/sys/fs/cgroup/chalk-crash-browser/memory.max'],{input:'1073741824',stdio:['pipe','ignore','inherit']});
    executablePath=join(task,'limited-chromium.sh');
    await writeFile(executablePath,`#!/bin/bash\nprintf '%s' "$$" | sudo tee /sys/fs/cgroup/chalk-crash-browser/cgroup.procs >/dev/null\nexec ${JSON.stringify(chromium.executablePath())} "$@"\n`,{mode:0o755});
  }
  const browser = await chromium.launch({headless:true,args,executablePath}); browsers.push(browser);
  const browserCDP = await browser.newBrowserCDPSession();
  const context = await browser.newContext({permissions:['camera','microphone']});
  await context.route('**/*', route => {
    const url=new URL(route.request().url());
    if(!['127.0.0.1','localhost'].includes(url.hostname))return route.abort();
    if(url.pathname.endsWith('/cancel-join'))return route.abort('connectionfailed');
    if(url.pathname.includes('/media/sfu/'))return; // Stalled signalling retains the real native peer/offer path.
    return route.continue();
  });
  await context.addInitScript({path:join(root,'scripts/research/tab-crash/instrument.js')});
  await context.routeWebSocket(/\/v1\/sync/, socket => { active.blockedSockets++; /* Deliberately never connect to real Sync. */ });
  const page = await context.newPage();
  page.on('crash',()=>emit({run:runName,crash:true}));
  page.on('pageerror',error=>emit({run:runName,pageerror:error.message}));
  page.on('console',message=>{if(message.type()==='error') emit({run:runName,console:message.text().slice(0,240)});});
  const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
  if(constrained) await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
  const tenant = await request('/v1/tenants',{name:`Crash research ${runName}`,default_media_plane:'cf_sfu',media_plane_provider_config:{enabled:true,provider:'cf_sfu',mode:'chalk_managed'}});
  const space = await request(`/v1/tenants/${tenant.id}/spaces`,{name:'Crash research',slug:`crash-${randomUUID()}`,media_plane:'cf_sfu',recording_policy:'manual',transcription_policy:'disabled',default_episode_duration_seconds:3600,maximum_episode_duration_seconds:3600,linger_window_seconds:600});
  runStart = Date.now();
  const fixture = async () => {
    const episode = await request(`/v1/tenants/${tenant.id}/spaces/${space.id}/episodes`,{});
    const path = `/v1/tenants/${tenant.id}/spaces/${space.id}/episodes/${episode.id}/participants`;
    const admission = await request(path,{name:'Crash research tutor',role:'owner'});
    active={tenant,space,episode,path,admission,grants:0,forbidden:0,blockedSockets:0,css};
  };
  const navigate = async () => {await page.goto('http://127.0.0.1:8090');await page.waitForFunction(()=>window.__ready);};
  const joinPage = async () => {await page.evaluate(()=>void window.__join()); await delay(constrained?1600:800);};
  const expire = (natural=false) => {
    const id=active.admission.participant.id;
    if(!natural) sql(`update participant_join_seats set expires_at=now()-interval '1 second' where participant_id='${id}';`);
    const state=sql(`select transition_participant_join_seat(tenant_id,space_id,episode_id,participant_id,generation,'expire') from participant_join_seats where participant_id='${id}'`);
    if(state!=='expired') throw new Error(`seat not expired: ${state}`);
  };
  emit({run:runName,chromium:browser.version(),profile:constrained?'1 GiB browser cgroup, 256 MiB V8 old space, 4x CPU throttle':'default',begin:true});
  // One full-duration incident: seven real grants over ~13 s, actual 120 s seat,
  // stale refresh and retries until seven minutes have elapsed.
  await fixture(); await navigate(); await joinPage();
  for(let n=1;n<7;n++) {await delay(2100);await page.evaluate(async()=>{ const response=await fetch('/access',{method:'POST'}); if(response.status!==201)throw new Error(`burst grant ${response.status}`);await response.json(); });}
  await sample(page,cdp,browserCDP,'soak-burst',runName,0);
  await page.screenshot({path:join(out,`${runName}-burst.png`)});
  const remaining=125000-(Date.now()-runStart); if(remaining>0) await delay(remaining);
  expire(true);
  await page.reload();await page.waitForFunction(()=>window.__ready);await joinPage();
  if(!active.forbidden) throw new Error('stale refresh did not get real 403');
  await sample(page,cdp,browserCDP,'soak-stale-403',runName,0);
  for(let n=1;n<=10;n++) { await page.evaluate(()=>window.__unmount());await page.evaluate(()=>window.__mount());await joinPage(); }
  for(let n=0;n<5;n++) {
    const next=(n+1)*59000+125000;const wait=next-(Date.now()-runStart);if(wait>0)await delay(wait);
    await sample(page,cdp,browserCDP,'soak',runName,n);
  }
  await request(`/v1/tenants/${tenant.id}/spaces/${space.id}/episodes/${active.episode.id}/end`,{});
  for(let cycle=1;cycle<=21;cycle++) {
    await fixture();await navigate();await joinPage();
    await sample(page,cdp,browserCDP,'pending',runName,cycle);
    expire();await page.reload();await page.waitForFunction(()=>window.__ready);await joinPage();
    if(!active.forbidden)throw new Error('accelerated stale refresh did not get 403');
    await sample(page,cdp,browserCDP,'stale-403',runName,cycle);
    await page.evaluate(()=>window.__unmount());await delay(1000);
    await cdp.send('HeapProfiler.collectGarbage');
    await sample(page,cdp,browserCDP,'disposed-gc',runName,cycle);
    await request(`/v1/tenants/${tenant.id}/spaces/${space.id}/episodes/${active.episode.id}/end`,{});
  }
  await context.close();await browser.close();
  if(constrained)emit({run:runName,memoryEvents:await readFile('/sys/fs/cgroup/chalk-crash-browser/memory.events','utf8')});
  emit({run:runName,complete:true});
}

try {
  await server((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({sessionId:randomUUID()}));},8088);
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const seed=privateKey.export({format:'jwk'}).d, pub=publicKey.export({format:'jwk'}).x;
  const signing=Buffer.concat([Buffer.from(seed,'base64url'),Buffer.from(pub,'base64url')]).toString('base64url');
  const identity = identityEnvironment({paths:{apiCertificate:join(task,'api.pem'),apiKey:join(task,'api.key'),syncCertificate:join(task,'sync.pem'),syncKey:join(task,'sync.key'),caCertificate:join(task,'ca.pem')},privateKey:signing,publicKeyring:{crash:pub},issuer:apiURL,kid:'crash'});
  const api=child(join(task,'api'),[],{...identity,CHALK_API_CORS_ALLOWED_ORIGINS:'http://127.0.0.1:8090',CHALK_API_ENV:'local',CHALK_API_LOCAL_SYSTEM_TOKEN:token,CHALK_API_ADDR:'127.0.0.1:8080',CHALK_REDIS_URL:'redis://127.0.0.1:6379',CHALK_DEFAULT_MEDIA_PLANE:'cf_sfu',CHALK_CLOUDFLARE_REALTIME_APP_ID:'fixture-app',CHALK_CLOUDFLARE_REALTIME_APP_SECRET:'fixture-secret',CHALK_CLOUDFLARE_REALTIME_BASE_URL:'http://127.0.0.1:8088',CHALK_SYNC_URL:'ws://127.0.0.1:4100/v1/sync',CHALK_SYNC_TOKEN_ISSUER:'http://127.0.0.1:8080',CHALK_SYNC_TOKEN_AUDIENCE:'chalk-sync',CHALK_SYNC_TOKEN_KEY_ID:'crash',CHALK_SYNC_TOKEN_PRIVATE_KEY:signing,CHALK_MEDIA_TOKEN_VERIFICATION_KEYS:JSON.stringify({crash:pub})},'api.log');
  await ready(apiURL+'/readyz',api);
  const mixEnv={...identity,MIX_ENV:'prod',ERL_FLAGS:'+S 2:2',CHALK_SYNC_LOCAL_PARITY:'true',CHALK_SYNC_BIND_IP:'127.0.0.1',CHALK_SYNC_MAX_WAL_LAG_BYTES:'0'};
  execFileSync('mix',['local.hex','--force'],{cwd:join(root,'apps/sync'),env:{...process.env,...mixEnv},stdio:'ignore'});
  execFileSync('mix',['deps.get'],{cwd:join(root,'apps/sync'),env:{...process.env,...mixEnv},stdio:'ignore'});
  const sync=child('mix',['run','--no-halt'],mixEnv,'sync.log',join(root,'apps/sync'));
  await ready('http://127.0.0.1:4100/readyz',sync);
  await server(async(req,res)=>{
    try {
      if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(asset);return;}
      if(req.url==='/access'){
        const admission=active.admission;
        const path=`${active.path}/${admission.participant.id}/access-grant`;
        const response=await fetch(apiURL+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({participant_generation:admission.participant.generation,replace_media_connection:true})});
        if(response.status===201)active.grants++;if(response.status===403)active.forbidden++;
        if(![201,403].includes(response.status))emit({accessUnexpected:response.status,body:await response.clone().text()});
        res.writeHead(response.status,{'Content-Type':'application/json'});res.end(await response.text());return;
      }
      res.setHeader('Content-Type','text/html');res.end(`<!doctype html><style>html,body,#root{margin:0;height:100%;width:100%}${active.css}</style><div id="root"></div><script>window.__space=${JSON.stringify(active.space.slug)}</script><script type="module" src="/app.js"></script>`);
    }catch(error){emit({httpError:error.message});res.writeHead(500);res.end('harness failure');}
  },8090);
  await bundle('5.2.0'); await bundle('master');
  for(const version of ['5.2.0','master'])for(const low of [false,true])await run(version,low);
} catch(error) {emit({failure:error.stack});process.exitCode=1;}
finally {
  for(const browser of browsers)await browser.close().catch(()=>{});
  for(const proc of children){try{process.kill(-proc.pid,'SIGTERM');}catch{}}
  for(const instance of servers)instance.closeAllConnections();
  await Promise.all(servers.map(instance=>new Promise(resolve=>instance.close(resolve))));
  await writeFile(join(out,'events.json'),JSON.stringify(events,null,2));
  console.log(`CRASH_RESULTS_BEGIN\n${JSON.stringify({rows,events})}\nCRASH_RESULTS_END`);
}
