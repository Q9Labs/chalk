import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const journey = String.raw`
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const origin='http://127.0.0.1:3098';
const existing=await fetch(origin,{signal:AbortSignal.timeout(1000)}).then(()=>true,()=>false);
if(existing) throw Error('Shell harness port 3098 occupied');
const server=spawn('pnpm',['exec','vite','--config','vite.call-states.config.ts','--port','3098','--strictPort'],{detached:true,stdio:'ignore'});
const watchdog=setTimeout(()=>{process.kill(-server.pid,'SIGTERM');process.exit(124)},110000);
let browser;
try {
 for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Harness exited');if(await fetch(origin+'/call-states.html').then(r=>r.ok,()=>false))break;await new Promise(r=>setTimeout(r,200));}
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:900},permissions:['clipboard-read','clipboard-write']});
 const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const load=async(state='shell-call')=>{await page.goto(origin+'/call-states.html?state='+state);await page.locator('[data-part="call-frame"]').waitFor()};
 await load('shell-seams');
 for(const [label,code,source] of [['Mute microphone','media.permission_denied','microphone'],['Turn off camera','media.device_not_found','camera'],['Share screen','client.internal_error','screen']]){
  await page.getByRole('button',{name:label,exact:true}).filter({visible:true}).click();
  await page.waitForFunction(({code,source})=>{const failure=JSON.parse(document.querySelector('[aria-label="Shell failure"]').textContent);return failure?.code===code&&failure?.source===source},{code,source});
 }

 await page.getByRole('button',{name:'Show call link',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Hide call link',exact:true}).getAttribute('aria-pressed'),'true');
 await page.getByRole('button',{name:'Hide call link',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Show call link',exact:true}).getAttribute('aria-pressed'),'false');
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Call details',exact:true}).click();
 await page.getByRole('dialog',{name:'Call details',exact:true}).getByRole('button',{name:'Show call link',exact:true}).click();
 await page.getByRole('dialog',{name:'Call details',exact:true}).waitFor({state:'detached'});
 await page.getByRole('button',{name:'Call details',exact:true}).click();
 assert.equal(await page.getByRole('dialog',{name:'Call details',exact:true}).getByRole('button',{name:'Hide call link',exact:true}).getAttribute('aria-pressed'),'true');
 await page.keyboard.press('Escape');
 await page.setViewportSize({width:1440,height:900});
 await load();
 await page.getByRole('button',{name:'Call details',exact:true}).click();
 await page.getByRole('button',{name:'Copy link',exact:true}).click();
 assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'https://chalkmeet.com/team-call');
 await page.getByRole('button',{name:'Light',exact:true}).click();
 assert.equal(await page.locator('[data-part="call-frame"]').getAttribute('data-chalk-theme'),'light');
 if(process.env.SHELL_ARTIFACTS){await mkdir(process.env.SHELL_ARTIFACTS,{recursive:true});await page.locator('[data-part="share-qr"]').screenshot({path:process.env.SHELL_ARTIFACTS+'/qr.png'});await page.screenshot({path:process.env.SHELL_ARTIFACTS+'/details-light.png'});}
 await page.reload();await page.locator('[data-part="call-frame"]').waitFor();assert.equal(await page.locator('[data-part="call-frame"]').getAttribute('data-chalk-theme'),'light');
 for(const name of ['Select microphone','Select camera']){
  await page.getByRole('button',{name,exact:true}).filter({visible:true}).click();
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(()=>document.querySelector('[role=menu]')?.contains(document.activeElement));
  await page.keyboard.press('End');await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({state:'detached'});
  assert.equal(await page.getByRole('button',{name,exact:true}).filter({visible:true}).evaluate(el=>el===document.activeElement),true);
 }
 await page.getByRole('button',{name:'Share options',exact:true}).click();
 await page.getByRole('menuitemradio',{name:'Browser tab',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('output')?.textContent?.includes('"surface":"browser"'));
 await page.getByRole('button',{name:'Leave call',exact:true}).filter({visible:true}).click();
 await page.waitForFunction(()=>document.querySelector('output')?.textContent==='Left call');
 assert.equal(await page.getByRole('menu').count(),0);
 await load('shell-host');
 await page.getByRole('button',{name:'Leave call',exact:true}).filter({visible:true}).click();
 await page.getByRole('menuitem',{name:'End call for everyone',exact:true}).waitFor();
 await page.getByRole('menuitem',{name:'Leave call',exact:true}).waitFor();
 await page.keyboard.press('Escape');
 await page.setViewportSize({width:390,height:844});await load();
 await page.getByRole('button',{name:'Call details',exact:true}).click();
 const sheet=page.getByRole('dialog',{name:'Call details',exact:true});await sheet.waitFor();
 for(let i=0;i<12;i++){await page.keyboard.press('Tab');assert.equal(await sheet.evaluate(el=>el.contains(document.activeElement)),true)}
 await page.keyboard.press('Escape');await sheet.waitFor({state:'detached'});
 assert.equal(await page.getByRole('button',{name:'Call details',exact:true}).evaluate(el=>el===document.activeElement),true);
 await page.getByRole('button',{name:'More options',exact:true}).click();
 await page.getByRole('button',{name:'Grid',exact:true}).click();
 await page.keyboard.press('Escape');
 const dots=page.getByRole('button',{name:/^Go to page /});
 assert.ok(await dots.count()>1);
 await dots.nth(1).click();
 assert.equal(await dots.nth(1).getAttribute('aria-current'),'page');
 if(process.env.SHELL_ARTIFACTS)await page.screenshot({path:process.env.SHELL_ARTIFACTS+'/phone-grid.png'});
 assert.deepEqual(errors,[]);
 console.log('PASS: shell details, devices, share source, leave, phone focus and page-dot pointer journeys');
} finally {clearTimeout(watchdog);await browser?.close();try{process.kill(-server.pid,'SIGTERM')}catch{}}
`;
it("keeps the shell journeys usable in the real call harness", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", journey], { timeout: 120_000, maxBuffer: 1024 * 1024 });
  expect(stdout).toContain("PASS: shell details");
}, 130_000);
