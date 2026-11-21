import { createEntrySender, mintEntryIds, type EntrySender } from "@q9labsai/chalk-client";

import { publicAPIBaseURL } from "./chalk-access";

/**
 * The boot beacon is the first byte a page can report: it runs before auth, before React, and records what the
 * app itself can never see — that the page arrived, whether it is framed, what the frame's device policy allows,
 * whether storage works. It mints cs_/dev_ before authentication so every later record has somewhere to land.
 * Inline and ES5 because it must run even where the bundle never parses.
 */
export const bootBeaconScript = (): string =>
  `(function(){var w=window,d=document,n=w.navigator;var rnd=function(){try{return w.crypto.randomUUID().replace(/-/g,"")}catch(e){return Math.random().toString(36).slice(2)}};
var cs=null,dev=null,eph=false;try{cs=sessionStorage.getItem("chalk.cs")}catch(e){}
if(!cs||cs.indexOf("cs_")!==0){cs="cs_"+rnd();try{sessionStorage.setItem("chalk.cs",cs)}catch(e){}}
try{dev=localStorage.getItem("chalk.dev")}catch(e){}
if(!dev||dev.indexOf("dev_")!==0){dev="dev_"+rnd();try{localStorage.setItem("chalk.dev",dev)}catch(e){eph=true;try{sessionStorage.setItem("chalk.dev",dev)}catch(e2){}}}
var storage="persistent";try{localStorage.setItem("chalk.t","1");localStorage.removeItem("chalk.t")}catch(e){storage="unavailable"}
var shown=false,sentVisible=false,seq=0;
var url=${JSON.stringify(publicAPIBaseURL().replace(/\/$/, ""))}+"/v1/public/entry";
var path=function(){var p=d.location?d.location.pathname:location.pathname;
if(/^\\/[A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+\\/?$/.test(p))return"space_public";
if(p.indexOf("/dashboard")===0)return"dashboard";
if(p.indexOf("/space/")===0)return"space_private";
return"site"}();
var policy=function(f){try{var pp=d.permissionsPolicy||d.featurePolicy;if(pp&&pp.allowsFeature)return pp.allowsFeature(f)?"true":"false";return"unavailable(no_api)"}catch(e){return"unavailable(no_api)"}};
var send=function(name,fields){var body=JSON.stringify({v:1,client_session_id:cs,device_id:dev,ephemeral_device:eph,build_id:${JSON.stringify(__APP_VERSION__)},events:[{kind:"fact",name:name,seq:++seq,est_server_ms:Date.now(),fields:fields}]});
try{if(n.sendBeacon&&n.sendBeacon(url,new Blob([body],{type:"application/json"})))return}catch(e){}
try{w.fetch(url,{method:"POST",body:body,keepalive:true,credentials:"omit",headers:{"content-type":"application/json"}}).catch(function(){})}catch(e){}};
send("boot.started",{entry_path:path,framed:w.top!==w.self,policy_camera:policy("camera"),policy_microphone:policy("microphone"),visibility:d.visibilityState,storage_state:storage});
d.addEventListener("visibilitychange",function(){if(!sentVisible&&d.visibilityState==="visible"){sentVisible=true;send("boot.visible",{})}});
w.addEventListener("pagehide",function(){send("boot.pagehide",{app_shown:shown})});
w.__chalkAppShown=function(){shown=true};w.__chalkEntrySend=send;
})();`;

let sender: EntrySender | undefined;
let lastIds: { cs: string; dev: string; ephemeral: boolean } | undefined;

export function entryIds(): { cs: string; dev: string; ephemeral: boolean } {
  lastIds ??= mintEntryIds();
  return lastIds;
}

export function entrySender(): EntrySender {
  sender ??= createEntrySender({ baseUrl: publicAPIBaseURL(), ...entryIds(), buildId: __APP_VERSION__ });
  return sender;
}

/** Module-side counterpart of the beacon: every pre-admission record goes out the same path. */
export function sendEntryEvent(name: string, fields: Record<string, unknown> = {}): void {
  entrySender().fact(name, fields);
}

/** Called by the app root when the shell has actually rendered; the beacon's pagehide reports it. */
export function markAppShown(): void {
  try {
    (globalThis as { __chalkAppShown?: () => void }).__chalkAppShown?.();
  } catch {
    /* never block the app */
  }
}
