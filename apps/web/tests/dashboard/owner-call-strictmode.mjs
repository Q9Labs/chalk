import { strict as assert } from "node:assert";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Actual OwnerCall hooks and SDK runtime; delayed route data and an admission
// transport held pending keep this focused on ownership, not media or Sync.
const web = resolve(import.meta.dirname, "../..");
const require = createRequire(resolve(web, "package.json"));
const React = require("react");
const { createRoot } = require("react-dom/client");
const { JSDOM } = require("jsdom");
const ts = require("typescript");
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const temporary = await mkdtemp(resolve(tmpdir(), "chalk-owner-strictmode-"));
const source = (await readFile(process.argv[2] ?? resolve(web, "src/components/dashboard/OwnerCall.tsx"), "utf8")).replace(/^import .*;\n/gm, "").replaceAll("import.meta.env.", "({}).");
const prefix = `
import React, {useMemo, useEffect, useState, useRef, useSyncExternalStore} from ${JSON.stringify(require.resolve("react"))};
import {createSpaceClientForPlatform as createReal} from ${JSON.stringify(resolve(web, "../../sdks/typescript/client/src/space-client/space-client.ts"))};
import {readReloadRejoin, reloadRejoinAccess, reloadRejoinStorageKey, writeReloadRejoin} from ${JSON.stringify(resolve(web, "../../sdks/typescript/client/src/space-client/reload-rejoin.ts"))};
import {z} from ${JSON.stringify(require.resolve("zod"))};
export const clients=[], admissions=[], failures=[], joins=[];
export {ownerAccess};
export let liveEpisodeId='episode-test';
export const setLiveEpisode=(id)=>{liveEpisodeId=id;};
let pageFailures=0;
export const failOnePageRead=()=>{pageFailures++;};
export let current;
let ready=false;
export const load=()=>{ready=true;};
export const reset=()=>{ready=false;};
function createSpaceClientForPlatform(...args) {
  const client=createReal(...args);
  const entry={client,disposed:0,left:0,getAccess:args[0].getAccess};
  const leave=client.leave.bind(client), dispose=client.dispose.bind(client);
  client.leave=()=>{entry.left++;return leave();};
  client.dispose=()=>{entry.disposed++;dispose();};
  clients.push(entry); return client;
}
const publicAPIBaseURL=()=>"http://engine.local";
const useProblemReports=()=>false;
const problemReporter=()=>()=>Promise.resolve();
const intentKey=()=>crypto.randomUUID();
const act=(_route,input)=>{admissions.push(input);return new Promise(()=>{});};
const readPage=async()=>{if(pageFailures>0){pageFailures--;throw Error('Transient call read failure');}return {live:liveEpisodeId?{id:liveEpisodeId}:null};};
const useSession=()=>({profile:{name:'Synthetic owner'}});
const useLoad=()=>({state:ready?{kind:'ready',data:{inviteUrl:'http://engine.local/space/call-test',call:{name:'Call'}}}:{kind:'loading'}});
const useSiteTheme=()=>({theme:'dark'});
const useNavigate=()=>()=>{};
const SiteRoot=({children})=>children;
function Chalk({client}) {
  current=client;
  const started=useRef(false);
  useEffect(()=>{if(started.current)return;started.current=true;joins.push(client);void client.join({microphone:false,camera:false}).catch(error=>failures.push(error));},[client]);
  return React.createElement('p',null,'Call UI mounted');
}
`;
let root;
let test;
try {
  const compiled = ts.transpileModule(prefix + source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const file = resolve(temporary, "OwnerCall.mjs");
  await writeFile(file, compiled);
  test = await import(file);
  const mount = () => React.createElement(React.StrictMode, null, React.createElement(test.OwnerCall, { spaceId: "call-test" }));
  for (let cycle = 0; cycle < 2; cycle++) {
    test.reset();
    const previous = test.clients.length;
    root = createRoot(document.getElementById("root"));
    await React.act(async () => root.render(mount()));
    assert.match(document.body.textContent, /Opening your call/);
    assert.equal(test.admissions.length, cycle, "No join before delayed call data arrives");
    test.load();
    await React.act(async () => root.render(mount()));
    await new Promise((done) => setImmediate(done));
    assert(!test.failures.some((error) => String(error).includes("ManagedRuntime disposed")), "Retained client runtime must remain usable");
    assert.equal(test.admissions.length, cycle + 1, `Exactly one admission per mount despite effect replay: ${test.failures.map(String).join("; ")}`);
    assert.equal(test.joins.length, cycle + 1, "No duplicate automatic joins");
    assert(
      test.clients.slice(previous).every((entry) => entry.getAccess === test.clients[previous].getAccess),
      "Effect replay preserves the same join intent",
    );
    const active = test.clients.slice(previous).filter((entry) => entry.disposed === 0);
    assert.equal(active.length, 1, "Every replayed/abandoned client is closed");
    assert.equal(active[0].client, test.current, "The UI uses the live client, not a disposed one");
    await test.current.leave();
    await React.act(async () => root.unmount());
    root = undefined;
    await new Promise((done) => setImmediate(done));
    for (const entry of test.clients) {
      assert(entry.left >= 1, "Every constructed client leaves");
      assert.equal(entry.disposed, 1, "Every constructed client is disposed exactly once");
    }
  }
  assert.notEqual(test.admissions[0].idempotencyKey, test.admissions[1].idempotencyKey, "A deliberate remount is a new join intent");
  const { writeReloadRejoin, reloadRejoinStorageKey } = await import(resolve(web, "../../sdks/typescript/client/src/space-client/reload-rejoin.ts"));
  for (const scenario of ["same-episode", "different-episode", "ended", "expired", "different-space", "transient-read"]) {
    const savedKey = crypto.randomUUID();
    writeReloadRejoin(
      window.sessionStorage,
      {
        space: scenario === "different-space" ? "another-call" : "call-test",
        episodeId: "episode-test",
        participantId: "participant-test",
        participantGeneration: 1,
        tenantId: "tenant-test",
        mediaProof: "synthetic-proof-not-a-credential",
        displayName: "Synthetic owner",
        microphone: false,
        camera: false,
        ownerJoinKey: savedKey,
      },
      scenario === "expired" ? Date.now() - 120001 : Date.now(),
    );
    test.setLiveEpisode(scenario === "ended" ? null : scenario === "different-episode" ? "another-episode" : "episode-test");
    const owner = test.ownerAccess("call-test");
    if (scenario === "transient-read") {
      test.failOnePageRead();
      await assert.rejects(owner.getAccess({ reason: "join", replaceMediaConnection: false }), /Transient call read failure/);
    }
    const beforeAdmission = test.admissions.length;
    const failures = [];
    void owner.getAccess({ reason: "join", replaceMediaConnection: false }).catch((error) => failures.push(error));
    await new Promise((done) => setImmediate(done));
    assert.equal(failures.length, 0, "A transient restoration failure must allow in-place Retry");
    assert.equal(test.admissions.length, beforeAdmission + 1, "Retry reaches owner admission");
    const key = test.admissions.at(-1).idempotencyKey;
    assert.equal(key === savedKey, scenario === "same-episode" || scenario === "transient-read", `Reload intent binding: ${scenario}`);
    assert.equal(window.sessionStorage.getItem(reloadRejoinStorageKey), null, "Reload marker is consumed even when rejected");
  }
  console.log("PASS: delayed OwnerCall StrictMode replay → one usable join → unmount/remount; every SDK client leaves and disposes");
  console.log("PASS: owner reload intent is single-use, short-lived and bound to the current Space/Episode");
} finally {
  if (root) await React.act(async () => root.unmount());
  for (const entry of test?.clients ?? []) {
    if (!entry.disposed) {
      await entry.client.leave();
      entry.client.dispose();
    }
  }
  dom.window.close();
  await rm(temporary, { recursive: true, force: true });
}
