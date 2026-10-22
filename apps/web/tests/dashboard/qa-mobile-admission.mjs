import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function provePublicAdmission({browser, page, origin, inviteUrl, repository}) {
  const out = resolve(repository, 'artifacts/qa-mobile-admission');
  await mkdir(out, {recursive:true});
  const results = [];
  const frames = [];
  const sockets = [];
  page.on('websocket', socket => {
    if (!socket.url().includes('/v1/sync')) return;
    sockets.push({time:new Date().toISOString()});
    socket.on('framereceived', ({payload}) => {
      const f = JSON.parse(String(payload));
      if (f.type === 'event') frames.push({name:f.name, revision:f.revision});
    });
  });
  if (await page.getByRole('button',{name:'Close call link',exact:true}).isVisible())
    await page.getByRole('button',{name:'Close call link',exact:true}).click();
  const invite = new URL(inviteUrl);
  const base = `${origin}${invite.pathname}${invite.search}${invite.hash}`;
  const guests = [];
  async function knock(name, prefilled) {
    const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const guest = await context.newPage();
    guests.push({context,guest,name});
    const url = new URL(base);
    if (prefilled) url.searchParams.set('name',name);
    await guest.goto(url.href);
    if (!prefilled) await guest.getByLabel('Your name').fill(name);
    else assert.equal(await guest.getByLabel('Your name').inputValue(),name);
    await guest.getByRole('button',{name:'Join',exact:true}).click();
    await guest.getByText(/Asking to join/).waitFor({timeout:15000});
    return {context,guest,name};
  }
  async function admit(g) {
    await page.getByRole('button',{name:`Admit ${g.name}`,exact:true}).click();
    await g.guest.locator('[data-tour="video-grid"]').first().waitFor({timeout:45000});
    await g.guest.getByRole('button',{name:'Leave call',exact:true}).click();
    await g.context.close();
  }
  try {
    for (const prefilled of [false,true]) {
      const name = prefilled ? 'Mobile prefilled' : 'Mobile form';
      const g = await knock(name,prefilled);
      const cdp = await g.context.newCDPSession(g.guest);
      await cdp.send('Page.setWebLifecycleState',{state:'frozen'});
      await page.bringToFront();
      await page.getByRole('button',{name:`Admit ${name}`,exact:true}).waitFor({timeout:15000});
      await page.screenshot({path:resolve(out,`${prefilled?'prefilled':'form'}-frozen-host.png`)});
      await cdp.send('Page.setWebLifecycleState',{state:'active'});
      await cdp.detach();
      await admit(g);
      results.push({case:name,pendingWhileFrozen:true,admitted:true});
    }
    const pair = await Promise.all([knock('Mobile pair one',true),knock('Mobile pair two',true)]);
    for (const g of pair) await page.getByRole('button',{name:`Admit ${g.name}`,exact:true}).waitFor({timeout:15000});
    await page.screenshot({path:resolve(out,'two-mobile-knocks-host.png')});
    for (const g of pair) await admit(g);
    results.push({case:'two mobile knocks',admitted:2});
    const reconnecting = await page.locator('[data-call-limbo][data-covered="true"]').filter({hasText:'Reconnecting'}).count();
    assert.equal(reconnecting,0);
    await writeFile(resolve(out,'result.json'),JSON.stringify({head:process.env.QA_PR_HEAD,results,reconnecting,sockets,frames},null,2));
    console.log('QA_MOBILE_ADMISSION_PASS '+JSON.stringify(results));
  } finally {
    for (const g of guests) await g.context.close().catch(()=>{});
    await writeFile(resolve(out,'progress.json'),JSON.stringify({results,sockets,frames},null,2));
  }
}
