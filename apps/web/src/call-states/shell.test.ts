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
 await page.getByRole('button',{name:'Switch to grid',exact:true}).click();
 await page.getByRole('button',{name:'Switch to spotlight',exact:true}).waitFor();
 await page.getByRole('button',{name:'Switch to spotlight',exact:true}).click();
 await page.getByRole('button',{name:'Switch to grid',exact:true}).waitFor();
 for (const viewport of [{width:1440,height:900},{width:390,height:844}]) {
  await page.setViewportSize(viewport);
  const trigger=page.getByRole('button',{name:'Reactions',exact:true});
  await trigger.click();
  const tray=page.getByRole('toolbar',{name:'Reactions',exact:true});
  await tray.waitFor();
  assert.deepEqual(await tray.getByRole('button',{name:/^React with /}).allTextContents(),['👍','❤️','😂','😮','🎉','👏']);
  await page.waitForFunction(()=>{
   const tray=document.querySelector('.chalk-shell-reactions')?.getBoundingClientRect();
   const trigger=document.querySelector('[data-part="dock"] button[aria-label="Reactions"]')?.getBoundingClientRect();
   return tray&&trigger&&Math.abs(trigger.top-tray.bottom-10)<1;
  });
  await page.keyboard.press('Escape');
 }
 await page.setViewportSize({width:1440,height:900});
 await page.getByRole('button',{name:'Call details',exact:true}).click();
 await page.getByRole('button',{name:'Copy link',exact:true}).click();
 assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'https://chalkmeet.com/team-call');
 await page.getByRole('button',{name:'Light',exact:true}).click();
 assert.equal(await page.locator('[data-part="call-frame"]').getAttribute('data-chalk-theme'),'light');
 if(process.env.SHELL_ARTIFACTS){await mkdir(process.env.SHELL_ARTIFACTS,{recursive:true});await page.locator('[data-part="share-qr"]').screenshot({path:process.env.SHELL_ARTIFACTS+'/qr.png'});await page.screenshot({path:process.env.SHELL_ARTIFACTS+'/details-light.png'});}
 await page.reload();await page.locator('[data-part="call-frame"]').waitFor();assert.equal(await page.locator('[data-part="call-frame"]').getAttribute('data-chalk-theme'),'light');
 for(const name of ['Select microphone','Select camera']){
  await page.getByRole('button',{name,exact:true}).filter({visible:true}).click();
  assert.equal(await page.getByRole('menuitemcheckbox').evaluateAll(items=>items.every(item=>{
   const track=item.querySelector('.chalk-switch')?.getBoundingClientRect();
   const row=item.getBoundingClientRect();
   return track&&track.width===36&&track.height===22&&track.left>=row.left&&track.right<=row.right;
  })),true);
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
 await load('shell-report');
 await page.getByRole('button',{name:'Call details',exact:true}).click();
 await page.getByRole('button',{name:'Report a problem',exact:true}).click();
 await page.getByRole('textbox',{name:'What went wrong?',exact:true}).fill('Audio dropped during the call');
 await page.getByRole('button',{name:'Send',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('output')?.textContent==='Reported: Audio dropped during the call');
 await page.getByRole('dialog',{name:'Sent',exact:true}).waitFor();
 await page.getByRole('button',{name:'Done',exact:true}).click();
 await page.getByRole('dialog').waitFor({state:'detached'});
 await load('shell-host');
 await page.getByRole('button',{name:'Record',exact:true}).click();
 await page.getByRole('button',{name:'Stop recording',exact:true}).waitFor();
 await page.getByRole('button',{name:'Stop recording',exact:true}).click();
 await page.getByRole('button',{name:'Record',exact:true}).waitFor();
 await page.getByRole('button',{name:'Leave call',exact:true}).filter({visible:true}).click();
 await page.getByRole('menuitem',{name:'End call for everyone',exact:true}).waitFor();
 await page.getByRole('menuitem',{name:'Leave call',exact:true}).waitFor();
 await page.keyboard.press('Escape');
 await page.setViewportSize({width:390,height:844});
 await load('shell-single-camera');
 await page.getByRole('button',{name:'More options',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Flip camera',exact:true}).count(),0);
 await page.keyboard.press('Escape');
 await load();
 await page.getByRole('button',{name:'More options',exact:true}).click();
 const flip=page.getByRole('button',{name:'Flip camera',exact:true});
 assert.ok((await flip.boundingBox()).height>=44);
 assert.equal(await page.getByRole('dialog',{name:'More options',exact:true}).getByRole('button',{name:/Select (microphone|camera)|Test speaker/}).count(),0);
 await flip.click();
 await page.getByLabel('Last shell command').filter({hasText:'Selected camera: cam-2'}).waitFor({state:'attached'});
 await page.getByRole('dialog',{name:'More options',exact:true}).waitFor({state:'detached'});
 await page.getByRole('button',{name:'Turn off camera',exact:true}).filter({visible:true}).click();
 await page.getByRole('button',{name:'More options',exact:true}).click();
 await flip.click();
 await page.getByLabel('Last shell command').filter({hasText:'Selected camera: cam-1'}).waitFor({state:'attached'});
 await page.getByRole('button',{name:'Turn on camera',exact:true}).filter({visible:true}).waitFor();
 await page.getByRole('button',{name:'Turn on camera',exact:true}).filter({visible:true}).click();
 await page.getByRole('button',{name:'Turn off camera',exact:true}).filter({visible:true}).waitFor();
 await page.setViewportSize({width:390,height:844});await load('shell-paged');
 await page.getByRole('button',{name:'Call details',exact:true}).click();
 const sheet=page.getByRole('dialog',{name:'Call details',exact:true});await sheet.waitFor();
 await page.waitForFunction(()=>document.querySelector('[role="dialog"]')?.contains(document.activeElement));
 for(let i=0;i<12;i++){
  await page.keyboard.press('Tab');
  await page.waitForFunction(()=>document.querySelector('[role="dialog"]')?.contains(document.activeElement));
  assert.equal(await sheet.evaluate(el=>el.contains(document.activeElement)),true);
 }
 await page.keyboard.press('Escape');await sheet.waitFor({state:'detached'});
 assert.equal(await page.getByRole('button',{name:'Call details',exact:true}).evaluate(el=>el===document.activeElement),true);
 await page.getByRole('button',{name:'More options',exact:true}).click();
 await page.getByRole('button',{name:'Grid',exact:true}).click();
 await page.keyboard.press('Escape');
 const dots=page.getByRole('button',{name:/^Go to page /});
 await dots.nth(1).waitFor();
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
