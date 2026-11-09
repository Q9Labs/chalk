// usage: node guest.mjs <pw|safari> <name> <freq> <hue> <t0Epoch> <inviteFile> <planFile> <outFile>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
const [, , kind, name, freq, hue, t0s, inviteFile, planFile, outFile] = process.argv;
const T0 = Number(t0s);
const inv = JSON.parse(readFileSync(inviteFile));
const plan = JSON.parse(readFileSync(planFile));
const here = new URL(".", import.meta.url).pathname;
const inject = readFileSync(here + "inject.js", "utf8");
const shotDir = process.env.SHOT_DIR ?? "/tmp/dress/shots";
mkdirSync(shotDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const actions = [];
const stamp = (what, ok = true, extra) => {
  actions.push({ t: Date.now(), rel: Math.round((Date.now() - T0) / 1000), what, ok, ...(extra ?? {}) });
  console.log(`[${name}] +${Math.round((Date.now() - T0) / 1000)}s ${what} ${ok}`);
};
let d;
if (kind === "pw") {
  const { createRequire } = await import("node:module");
  const { chromium } = createRequire("/data/home/work/sdks/typescript/client/package.json")("playwright");
  const b = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(`(${(await import("/data/home/work/scripts/prod-proof/pc-diagnostics.mjs")).installPcDiagnostics.toString()})()`);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => stamp("pageerror: " + String(e.message).slice(0, 200), false));
  page.on("console", (m) => {
    if (m.type() === "error") stamp("console.error: " + m.text().slice(0, 200), false);
  });
  d = {
    version: "Chromium " + b.version() + " (Playwright, headless)",
    goto: (u) => page.goto(u, { waitUntil: "load" }),
    ev: (body) => page.evaluate(`(async()=>{${body}})()`),
    click: async (names) => {
      for (const n of names) {
        const l = page.locator(`button[aria-label="${n}"], button:text-is("${n}")`).first();
        if (await l.count()) {
          try {
            await l.click({ timeout: 4000 });
            return n;
          } catch {
            await l.evaluate((e) => e.click());
            return n + " (js)";
          }
        }
      }
      return null;
    },
    fillName: (t) => page.getByLabel("Your name").fill(t),
    shot: (p) => page.screenshot({ path: p }),
    close: () => b.close(),
  };
} else {
  const port = 4444 + Math.floor(Math.random() * 100);
  const drv = spawn("/usr/bin/safaridriver", ["-p", String(port)], { stdio: "ignore" });
  await sleep(1500);
  const wd = async (method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (j.value?.error) throw new Error(`${j.value.error}: ${String(j.value.message).slice(0, 150)}`);
    return j.value;
  };
  const created = await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } });
  const sid = created.sessionId;
  await wd("POST", `/session/${sid}/window/rect`, { width: 1280, height: 800, x: 40, y: 40 }).catch(() => {});
  const byXpath = async (x) => (await wd("POST", `/session/${sid}/elements`, { using: "xpath", value: x }))[0];
  const idOf = (e) => e["element-6066-11e4-a52e-4f735466cecf"];
  d = {
    version: `Safari ${created.capabilities.browserVersion} (${created.capabilities.platformName}, safaridriver)`,
    goto: (u) => wd("POST", `/session/${sid}/url`, { url: u }),
    ev: (body) => wd("POST", `/session/${sid}/execute/async`, { script: `const done=arguments[arguments.length-1];(async()=>{${body}})().then(v=>done(v===undefined?null:v),e=>done({__err:String(e)}));`, args: [] }),
    click: async (names) => {
      for (const n of names) {
        const e = await byXpath(`//button[@aria-label="${n}" or normalize-space(.)="${n}"]`);
        if (e) {
          try {
            await wd("POST", `/session/${sid}/element/${idOf(e)}/click`, {});
            return n;
          } catch {
            await wd("POST", `/session/${sid}/execute/sync`, { script: "arguments[0].click()", args: [e] });
            return n + " (js)";
          }
        }
      }
      return null;
    },
    fillName: async (t) => {
      const e = await byXpath("//input");
      await wd("POST", `/session/${sid}/element/${idOf(e)}/value`, { text: t });
    },
    shot: async (p) => writeFileSync(p, Buffer.from(await wd("GET", `/session/${sid}/screenshot`), "base64")),
    close: async () => {
      await wd("DELETE", `/session/${sid}`).catch(() => {});
      drv.kill();
    },
  };
}
const MIC_OFF = ["Mute microphone"];
const MIC_ON = ["Unmute microphone"];
const CAM_OFF = ["Turn off camera", "Turn camera off", "Stop camera"];
const CAM_ON = ["Turn on camera", "Turn camera on", "Start camera"];
const callUp = `return !!__rehearsal.find("Leave call")`;
const doAction = async (a) => {
  if (a.do === "join") {
    await d.goto(inv.url);
    await d.ev(inject);
    await d.ev(`__rehearsal.name=${JSON.stringify(name)};__rehearsal.freq=${freq};__rehearsal.hue=${hue};__rehearsal.start(250);return 1`);
    await sleep(800);
    await d.fillName(name);
    const t = Date.now();
    const c = await d.click(["Join call"]);
    stamp("join click", !!c);
    for (let i = 0; i < 60; i++) {
      if (await d.ev(callUp)) break;
      await sleep(500);
    }
    stamp("join UI up", true, { ms: Date.now() - t });
    await sleep(1500);
    stamp("mic on at join", !!(await d.click(MIC_ON)));
    stamp("camera on at join", !!(await d.click(CAM_ON)));
  } else if (a.do === "mic") {
    const o = await d.click(MIC_OFF);
    stamp("mic off", !!o, { via: o });
    await sleep(6000);
    const n = await d.click(MIC_ON);
    stamp("mic on", !!n, { via: n });
  } else if (a.do === "cam") {
    const o = await d.click(CAM_OFF);
    stamp("camera off", !!o, { via: o });
    await sleep(6000);
    const n = await d.click(CAM_ON);
    stamp("camera on", !!n, { via: n });
  } else if (a.do === "share") {
    const o = await d.click(["Share screen"]);
    stamp("share start", !!o, { via: o });
  } else if (a.do === "unshare") {
    const o = await d.click(["Stop sharing"]);
    stamp("share stop", !!o, { via: o });
  } else if (a.do === "leave") {
    const o = await d.click(["Leave call"]);
    stamp("leave", !!o);
  } else if (a.do === "rejoin") {
    const t = Date.now();
    let o = null;
    for (let i = 0; i < 40 && !o; i++) {
      o = await d.click(["Rejoin"]);
      if (!o) await sleep(500);
    }
    stamp("rejoin click", !!o);
    for (let i = 0; i < 60; i++) {
      if (await d.ev(callUp)) break;
      await sleep(500);
    }
    stamp("rejoin UI up", true, { ms: Date.now() - t });
    await sleep(1500);
    stamp("mic on after rejoin", !!(await d.click(MIC_ON)));
    stamp("camera on after rejoin", !!(await d.click(CAM_ON)));
  } else if (a.do === "shot") {
    const p = `${shotDir}/${name.replace(/\W/g, "")}-${a.label}.png`;
    await d.shot(p).catch((e) => stamp("shot failed " + e.message, false));
    stamp("shot " + p);
  }
};
const dump = async () => {
  const r = await d
    .ev(`return {diag:window.__pcDiag,ua:navigator.userAgent,history:__rehearsal.history,logs:__rehearsal.logs,grants:__rehearsal.grants,pcs:__rehearsal.pcs.map(p=>p.connectionState),shareStarted:__rehearsal.shareStarted||0,shareEnded:__rehearsal.shareEnded||0}`)
    .catch((e) => ({ err: String(e) }));
  writeFileSync(outFile, JSON.stringify({ name, version: d.version, actions, ...r }));
};
try {
  const periodic = setInterval(dump, 60000);
  for (const a of [...plan].sort((x, y) => x.at - y.at)) {
    const wait = T0 + a.at * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    await doAction(a).catch((e) => stamp(`${a.do} threw ${String(e.message).slice(0, 150)}`, false));
  }
  clearInterval(periodic);
  await dump();
} finally {
  await d.close();
}
stamp("done");
