import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
if (process.env.CHALK_RUN_LIVE_SFU_CAPTURE_TEST !== "1") throw Error("CHALK_RUN_LIVE_SFU_CAPTURE_TEST=1 required");
if (!process.argv[2]) throw Error("Usage: node scripts/capture-ingress/run.mjs <new-private-output-directory>");
const out = resolve(process.argv[2]);
await mkdir(out, { mode: 0o700 });
const session = "chalk-ingress-" + randomUUID().slice(0, 8);
const requireSDK = createRequire(root + "/sdks/typescript/client/package.json");
const { build } = requireSDK("esbuild");
let server, child, chalk, space, episode, ownerToken;
let browserOpened = false;
let credentialFileCreated = false;
const credentialPath = out + "/.runtime-credentials.json";
const ownedAssets = [];
const parent = process.ppid;
const abort = new AbortController();
const monitor = setInterval(() => {
  if (process.ppid !== parent) abort.abort(new Error("owner lost"));
}, 1000);
const deadline = setTimeout(() => abort.abort(new Error("measurement lifetime exceeded")), 420000);
const events = [];
const stamp = (event) => {
  events.push({ event, at: Date.now() });
  console.log(event);
};
process.once("SIGTERM", () => abort.abort(new Error("terminated")));
process.once("SIGINT", () => abort.abort(new Error("interrupted")));
const abArgs = ["--session", session, "--idle-timeout", "1h", "--json"];
async function browser(args) {
  const { stdout } = await exec("agent-browser", [...abArgs, ...args], { timeout: 45000, maxBuffer: 2 * 1024 * 1024, signal: abort.signal });
  const result = JSON.parse(stdout);
  if (!result.success) throw new Error("browser command failed: " + JSON.stringify(result.error));
  return result.data?.result ?? result.data;
}
const evaluate = (code) => browser(["eval", "-b", Buffer.from(code).toString("base64")]);
async function api(method, path, body) {
  const response = await fetch("http://127.0.0.1:18080" + path, {
    method,
    headers: { Authorization: "Bearer " + ownerToken, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]),
  });
  if (!response.ok) throw new Error("local API " + method + " " + path.replace(/[0-9a-f-]{36}/g, ":id") + " HTTP " + response.status);
  return response.json();
}
try {
  const manifest = JSON.parse(await readFile(root + "/.private/chalk-dev/manifest.json", "utf8"));
  if (manifest.checkout !== root) throw Error("local stack belongs to another checkout");
  if (manifest.urls.api !== "http://127.0.0.1:18080" || manifest.urls.web !== "http://127.0.0.1:13070") throw Error("start local stack with CHALK_DEV_API_PORT=18080 CHALK_DEV_WEB_PORT=13070");
  if (manifest.state !== "ready") throw new Error("documented local stack is not ready: " + manifest.state);
  const apiRecord = manifest.services.find(([id]) => id === "api")?.[1];
  if (!apiRecord?.pid) throw new Error("local API PID missing");
  const { stdout: environment } = await exec("ps", ["eww", "-p", String(apiRecord.pid), "-o", "command="]);
  ownerToken = environment.match(/(?:^|\s)CHALK_API_LOCAL_SYSTEM_TOKEN=([^\s]+)/)?.[1];
  if (!ownerToken) throw new Error("own local API token unavailable");
  // The documented launcher resolves this app with its production-rejecting
  // resolver before becoming ready. Reuse that exact process's credentials.
  const credential = {
    appId: environment.match(/(?:^|\s)CHALK_CLOUDFLARE_REALTIME_APP_ID=([^\s]+)/)?.[1],
    appSecret: environment.match(/(?:^|\s)CHALK_CLOUDFLARE_REALTIME_APP_SECRET=([^\s]+)/)?.[1],
  };
  if (!credential.appId || !credential.appSecret) throw Error("ready local stack SFU credentials missing");
  await readFile(root + "/.private/chalk-dev/sfu-source.json", "utf8");
  await writeFile(credentialPath, JSON.stringify({ ...credential, ownerToken }), { mode: 0o600, flag: "wx" });
  credentialFileCreated = true;
  const tenants = await api("GET", "/v1/tenants?page_size=100");
  const tenant = tenants.tenants.find((x) => x.name.startsWith("Chalk local dev "));
  if (!tenant) throw new Error("local fixture tenant missing");
  await build({ entryPoints: [root + "/sdks/typescript/client/src/server/index.ts"], bundle: true, outfile: out + "/sdk-server.mjs", format: "esm", platform: "node" });
  const { createChalkServerClient, getAccessRefreshState } = await import(out + "/sdk-server.mjs");
  chalk = createChalkServerClient({ apiKey: ownerToken, tenantId: tenant.id, apiBaseURL: "http://127.0.0.1:18080", fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30000) }) });
  space = await api("POST", `/v1/tenants/${tenant.id}/spaces`, { name: "Ingress synthetic camera", slug: session, media_plane: "cf_sfu", recording_policy: "manual", admission_policy: { mode: "open" } });
  episode = await chalk.episodes.create(space.id, {});
  let admission = await chalk.participants.admit(space.id, episode.id, { name: "Ingress synthetic camera", role: "owner" });
  let access = admission.access,
    first = true;
  server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:13070");
    response.setHeader("Cache-Control", "no-store");
    if (request.url !== "/access") {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      if (!first) access = await chalk.participants.issueAccess(space.id, episode.id, admission.participant.id, getAccessRefreshState(access));
      first = false;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(access));
    } catch {
      response.writeHead(500);
      response.end("access failed");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(13071, "127.0.0.1", resolve);
  });
  const bundle = await build({
    stdin: {
      contents: `import {createSpaceClientForPlatform} from './sdks/typescript/client/src/effect.ts';
window.ingressJoin=async()=>{window.ingressClient=createSpaceClientForPlatform({space:${JSON.stringify(space.slug)},baseUrl:'http://127.0.0.1:18080',getAccess:async()=>{const r=await fetch('http://127.0.0.1:13071/access');if(!r.ok)throw Error('access');return r.json();}},{syncUrl:'ws://127.0.0.1:4100/v1/sync'});await window.ingressClient.join({displayName:'Ingress synthetic camera',microphone:false,camera:true});return {state:window.ingressClient.getSnapshot().connection.status,publication:window.ingressPublication,encodings:window.ingressPCs.flatMap(p=>p.getSenders()).filter(s=>s.track?.kind==='video').map(s=>s.getParameters().encodings)}};`,
      resolveDir: root,
      sourcefile: "ingress.ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    plugins: [
      {
        name: "source",
        setup(builder) {
          builder.onResolve({ filter: /^@q9labsai\/diagnostics-contracts$/ }, () => ({ path: root + "/packages/diagnostics-contracts/src/index.ts" }));
        },
      },
    ],
  });
  const fixture = `<!doctype html><title>Ingress synthetic camera</title><script>
window.ingressPCs=[];const PC=window.RTCPeerConnection;window.RTCPeerConnection=class extends PC{constructor(...args){super(...args);window.ingressPCs.push(this)}};
const nativeFetch=window.fetch;window.fetch=async(input,init)=>{if(String(input).includes('/media/sfu/tracks')&&init?.body){const b=JSON.parse(init.body);const camera=b.tracks?.find(t=>t.location==='local'&&t.trackName?.startsWith('camera-'));if(camera)window.ingressPublication={session:b.connection_id,track:camera.trackName};}return nativeFetch(input,init)};
navigator.mediaDevices.getUserMedia=async()=>{const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const c=canvas.getContext('2d');let frame=0;window.ingressTimer=setInterval(()=>{c.fillStyle='#1b365d';c.fillRect(0,0,1280,720);c.fillStyle='white';c.font='64px sans-serif';c.fillText('Proof guest 1',60,100);c.fillText('Frame '+frame++,60,200);for(let n=0;n<30;n++){c.fillStyle=\`hsl(\${(frame*7+n*12)%360} 70% 60%)\`;c.fillRect((frame*11+n*61)%1280,250+(n%5)*80,70,60)}},1000/15);return canvas.captureStream(15)};
</script><script src='/ingress-bundle.js'></script>`;
  await writeFile(root + "/apps/web/public/ingress-bundle.js", bundle.outputFiles[0].text, { flag: "wx" });
  ownedAssets.push("ingress-bundle.js");
  await writeFile(root + "/apps/web/public/ingress-fixture.html", fixture, { flag: "wx" });
  ownedAssets.push("ingress-fixture.html");
  browserOpened = true;
  await browser(["--args", "--use-fake-ui-for-media-stream,--use-fake-device-for-media-stream,--autoplay-policy=no-user-gesture-required", "open", "http://127.0.0.1:13070/ingress-fixture.html"]);
  const joined = await evaluate("window.ingressJoin()");
  await writeFile(out + "/publisher.json", JSON.stringify(joined, null, 2), { mode: 0o600 });
  if (!joined.publication?.session || !joined.publication?.track) throw new Error("SDK camera publication not observed");
  if (joined.encodings?.length !== 1 || joined.encodings[0].map((e) => e.rid).join(",") !== "h,l") throw new Error("SDK h/l simulcast not negotiated");
  stamp("publisher-ready");
  const env = { ...process.env, GOMAXPROCS: "1", CHALK_INGRESS_MEASUREMENT: "1", INGRESS_APP_ID: credential.appId, INGRESS_APP_SECRET: credential.appSecret, INGRESS_PUBLISHER_SESSION: joined.publication.session, INGRESS_TRACK: joined.publication.track, INGRESS_OUTPUT: out };
  const { open } = await import("node:fs/promises");
  const log = await open(out + "/capture.log", "a", 0o600);
  child = spawn("go", ["test", "-p", "1", "./internal/recorderworker", "-run", "^TestIngressMeasurement$", "-count=1", "-parallel", "2", "-v", "-timeout", "240s"], { cwd: root + "/apps/api", env, stdio: ["ignore", log.fd, log.fd], detached: true });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  stamp("capture-started");
  const readyDeadline = Date.now() + 45000;
  for (;;) {
    if (child.exitCode !== null) throw new Error("Capture exited before paired readiness");
    try {
      await readFile(out + "/omitted.ready");
      await readFile(out + "/explicit.ready");
      break;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (Date.now() > readyDeadline) throw new Error("paired Capture readiness deadline");
    await delay(250, undefined, { signal: abort.signal });
  }
  stamp("paired-ready");
  await delay(60000, undefined, { signal: abort.signal });
  const limited = await evaluate(
    `(async()=>{const s=window.ingressPCs.flatMap(p=>p.getSenders()).find(s=>s.track?.kind==='video');const p=s.getParameters();if(p.encodings.map(e=>e.rid).join(',')!=='h,l')throw Error('unexpected RIDs');for(const e of p.encodings){e.active=e.rid==='l';e.maxBitrate=80000}await s.setParameters(p);return s.getParameters().encodings})()`,
  );
  stamp("bandwidth-limited");
  await writeFile(out + "/limit.json", JSON.stringify({ at: Date.now(), encodings: limited }, null, 2), { mode: 0o600 });
  await delay(45000, undefined, { signal: abort.signal });
  await evaluate(`(async()=>{const s=window.ingressPCs.flatMap(p=>p.getSenders()).find(s=>s.track?.kind==='video');const p=s.getParameters();for(const e of p.encodings){e.active=true;e.maxBitrate=e.rid==='h'?2500000:650000}await s.setParameters(p);return true})()`);
  stamp("bandwidth-restored");
  const code = await Promise.race([
    done,
    delay(90000, undefined, { signal: abort.signal }).then(() => {
      throw Error("Capture completion deadline");
    }),
  ]);
  await log.close();
  if (code !== 0) throw new Error("Capture measurement failed; see private capture.log");
  stamp("measurement-complete");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  abort.abort(new Error("finished"));
  clearInterval(monitor);
  clearTimeout(deadline);
  if (child && child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    await delay(1000);
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }
  if (browserOpened) {
    try {
      await exec("agent-browser", ["--session", session, "close"], { timeout: 15000 });
    } catch (error) {
      console.error("browser cleanup failed: " + error.message);
      process.exitCode = 1;
    }
  }
  if (episode && space && chalk) {
    try {
      await chalk.episodes.end(space.id, episode.id);
    } catch {
      console.error("local Episode cleanup failed");
      process.exitCode = 1;
    }
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  if (credentialFileCreated) {
    try {
      await unlink(credentialPath);
    } catch (error) {
      console.error("credential cleanup failed: " + error.code);
      process.exitCode = 1;
    }
  }
  for (const file of ownedAssets) {
    try {
      await unlink(root + "/apps/web/public/" + file);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  await writeFile(out + "/events.json", JSON.stringify({ session, events }, null, 2), { mode: 0o600 });
}
