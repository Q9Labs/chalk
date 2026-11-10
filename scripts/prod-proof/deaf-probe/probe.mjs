// Is a listener deaf after a speaker re-publishes the microphone? Two real-browser guests join one Chalk SFU Space through its public
// invite. The first and second joiner (A, B) alternate three mic off/on cycles each. Every second each page records its audio
// transceivers (mid, direction, receiver readyState and muted), inbound/outbound audio RTP and the sender's media-source energy.
// Per re-publish, in the window 4..14 s after the unmute click: sender source energy <= 0.001 is a rig fault (RIG-SENDER-SILENT),
// no inbound packets is NO-PACKETS, no inbound energy gain is DEAF, otherwise HEARS.
//
//   node probe.mjs            env: CHALK_PROOF_API_KEY, CHALK_PROOF_TENANT_ID, CHALK_PROOF_API_URL, CHALK_PROOF_WEB_URL,
//                             PROBE_FIRST / PROBE_SECOND ("chromium" | "safari", default chromium), PROBE_OUT (output directory).
// Chromium runs headless under Playwright. Safari is the real browser driven through safaridriver (one Safari per run).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const env = (name, fallback) =>
  process.env[name] ??
  fallback ??
  (() => {
    throw new Error(`${name} is required`);
  })();
const API = env("CHALK_PROOF_API_URL");
const WEB = env("CHALK_PROOF_WEB_URL");
const tenant = `/v1/tenants/${env("CHALK_PROOF_TENANT_ID")}`;
const kinds = [env("PROBE_FIRST", "chromium"), env("PROBE_SECOND", "chromium")];
const out = env("PROBE_OUT", join(homedir(), "sfu-ops", "out", `probe-${Date.now()}`));
mkdirSync(out, { recursive: true });
const inject = readFileSync(new URL("./inject.js", import.meta.url), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const call = async (method, path, body) => {
  const response = await fetch(new URL(path, API), {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("CHALK_PROOF_API_KEY")}`, Origin: WEB, "Idempotency-Key": randomUUID(), "X-Chalk-Media-Providers": "cloudflare_sfu,chalk_sfu", "User-Agent": "Chalk-Deaf-Probe/1.0" },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")} ${response.status}`);
  return text ? JSON.parse(text) : {};
};

// Runs inside each page after the rehearsal instrumentation: the per-second sample and the join grant's unifiedSignaling flag.
function installSampler() {
  const deaf = (window.__deaf = { unified: null });
  const scan = (v, depth = 0) => {
    if (!v || typeof v !== "object" || depth > 6) return;
    if ("unifiedSignaling" in v) deaf.unified = v.unifiedSignaling;
    for (const child of Object.values(v)) scan(child, depth + 1);
  };
  const original = window.fetch;
  window.fetch = async function (...args) {
    const response = await original.apply(this, args);
    try {
      if ((response.headers.get("content-type") || "").includes("json"))
        response
          .clone()
          .json()
          .then(scan, () => {});
    } catch {}
    return response;
  };
  deaf.sample = async () => {
    const pcs = window.__rehearsal.pcs;
    const live = pcs.filter((pc) => pc.connectionState !== "closed");
    const trans = [];
    const inA = [];
    const outA = [];
    const src = [];
    for (const pc of live) {
      for (const t of pc.getTransceivers()) {
        const rt = t.receiver.track;
        const st = t.sender.track;
        trans.push({ mid: t.mid, dir: t.direction, cur: t.currentDirection, rk: rt && rt.kind, rrs: rt && rt.readyState, rmuted: rt && rt.muted, sk: st ? st.kind : null, srs: st ? st.readyState : null, sen: st ? st.enabled : null });
      }
      for (const r of (await pc.getStats()).values()) {
        if ((r.kind || r.mediaType) !== "audio") continue;
        if (r.type === "inbound-rtp") inA.push({ ssrc: r.ssrc, mid: r.mid, pk: r.packetsReceived, by: r.bytesReceived, en: r.totalAudioEnergy || 0 });
        else if (r.type === "outbound-rtp") outA.push({ ssrc: r.ssrc, pk: r.packetsSent, by: r.bytesSent });
        else if (r.type === "media-source") src.push({ tid: r.trackIdentifier, en: r.totalAudioEnergy || 0 });
      }
    }
    return { states: live.map((pc) => pc.connectionState), trans, inA, outA, src, pcCount: pcs.length };
  };
  return 1;
}

// A guest is {kind, open(url), ev(expression), shot(path), close()}; ev awaits the expression and returns its JSON value.
async function chromiumGuest(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  return {
    kind: "chromium",
    open: (url) => page.goto(url, { waitUntil: "load" }),
    ev: (expression) => page.evaluate(`(async () => (${expression}))()`),
    shot: (path) => page.screenshot({ path }),
    close: () => context.close(),
  };
}

async function safariGuest(port) {
  const wd = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await response.json();
    if (json.value?.error) throw new Error(`${method} ${path.replace(/[0-9a-f-]{20,}/g, ":id")}: ${json.value.error} ${json.value.message ?? ""}`.slice(0, 300));
    return json.value;
  };
  const session = (await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } })).sessionId;
  await wd("POST", `/session/${session}/timeouts`, { script: 30_000, pageLoad: 60_000 });
  return {
    kind: "safari",
    open: (url) => wd("POST", `/session/${session}/url`, { url }),
    ev: async (expression) => {
      const script = `const done = arguments[arguments.length - 1]; (async () => (${expression}))().then((v) => done(JSON.stringify(v === undefined ? null : v)), (e) => done(JSON.stringify({ __err: String((e && e.message) || e) })));`;
      const parsed = JSON.parse(await wd("POST", `/session/${session}/execute/async`, { script, args: [] }));
      if (parsed && parsed.__err) throw new Error(parsed.__err);
      return parsed;
    },
    shot: async (path) => writeFileSync(path, Buffer.from(await wd("GET", `/session/${session}/screenshot`), "base64")),
    close: () => wd("DELETE", `/session/${session}`),
  };
}

const children = [];
let browser;
const guests = [];
const timeline = [];
const actions = [];
let spaceRef;
try {
  const space = await call("POST", `${tenant}/spaces`, {
    name: `deaf-probe-${Date.now()}`,
    slug: `deaf-${randomUUID()}`,
    media_plane: "chalk_sfu",
    recording_policy: "manual",
    transcription_policy: "on_demand",
    default_episode_duration_seconds: 900,
    maximum_episode_duration_seconds: 900,
    linger_window_seconds: 60,
    admission_policy: { mode: "open" },
    metadata: { deaf_probe: "1" },
  });
  if (space.media_plane !== "chalk_sfu") throw new Error(`Space media plane is ${space.media_plane}, expected chalk_sfu`);
  const episode = await call("POST", `${tenant}/spaces/${space.id}/episodes`, { metadata: { deaf_probe: "1" } });
  spaceRef = { space: space.id, episode: episode.id };
  const invite = await call("PATCH", `${tenant}/spaces/${space.id}/public-invite`, { enabled: true });
  const inviteURL = new URL(invite.canonical_url);
  const joinURL = WEB + inviteURL.pathname + inviteURL.search + inviteURL.hash;
  console.log(`Space ${space.id} plane ${space.media_plane} Episode ${episode.id} first=${kinds[0]} second=${kinds[1]}`);

  if (kinds.includes("chromium")) {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  }
  if (kinds.includes("safari")) {
    children.push(spawn("safaridriver", ["-p", "4445"], { stdio: "ignore" }));
    await sleep(2000);
  }

  const names = ["PR A", "PR B"];
  for (const [index, kind] of kinds.entries()) {
    const guest = kind === "safari" ? await safariGuest(4445) : await chromiumGuest(browser);
    guest.key = ["A", "B"][index];
    guest.name = names[index];
    guests.push(guest);
    await guest.open(joinURL);
    await guest.ev(`(() => { ${inject}\n return 1; })()`);
    await guest.ev(`(${installSampler.toString()})()`);
    await guest.ev(`(() => { __rehearsal.name = ${JSON.stringify(guest.name)}; __rehearsal.freq = ${440 + index * 220}; __rehearsal.hue = ${index * 120}; return 1; })()`);
    await sleep(800);
    if (!(await guest.ev(`__rehearsal.fill("Your name", ${JSON.stringify(guest.name)})`))) throw new Error(`${guest.key}: name field not found`);
    if (!(await guest.ev(`__rehearsal.click("Join call")`))) throw new Error(`${guest.key}: Join call not found`);
    for (let i = 0; ; i++) {
      if (await guest.ev(`!!__rehearsal.find("Leave call")`)) break;
      if (i > 120) throw new Error(`${guest.key}: never reached the call`);
      await sleep(500);
    }
    await sleep(1500);
  }
  // Both in the call: wait until each page has a live peer connection, then publish mic and camera.
  for (const guest of guests) {
    for (let i = 0; ; i++) {
      const s = await guest.ev(`__deaf.sample()`);
      if (s.states.includes("connected")) break;
      if (i > 60) throw new Error(`${guest.key}: no connected peer connection`);
      await sleep(500);
    }
    if (!(await guest.ev(`__rehearsal.click("Unmute microphone")`))) throw new Error(`${guest.key}: Unmute microphone not found`);
    await guest.ev(`__rehearsal.click("Turn on camera")`);
    for (let i = 0; !(await guest.ev(`!!__rehearsal.find("Mute microphone")`)); i++) {
      if (i > 30) throw new Error(`${guest.key}: microphone did not publish`);
      await sleep(500);
    }
  }

  const t0 = Date.now();
  const now = () => Date.now() - t0;
  const wait = (ms) => sleep(Math.max(0, ms - now()));
  let stop = false;
  const sampler = (async () => {
    while (!stop) {
      const tick = now();
      await Promise.all(
        guests.map(async (guest) => {
          try {
            timeline.push({ t: tick, who: guest.key, ...(await guest.ev(`__deaf.sample()`)) });
          } catch (e) {
            timeline.push({ t: tick, who: guest.key, error: String(e.message).slice(0, 160) });
          }
        }),
      );
      await sleep(Math.max(0, 1000 - (now() - tick)));
    }
  })();

  await wait(15_000);
  let base = 15_000;
  for (const [i, who] of ["A", "B", "A", "B", "A", "B"].entries()) {
    const guest = guests.find((g) => g.key === who);
    await wait(base);
    const off = now();
    if (!(await guest.ev(`__rehearsal.click("Mute microphone")`))) throw new Error(`${who}: Mute microphone not found`);
    await wait(base + 6000);
    const on = now();
    if (!(await guest.ev(`__rehearsal.click("Unmute microphone")`))) throw new Error(`${who}: Unmute microphone not found`);
    actions.push({ cycle: i + 1, who, off, on });
    await wait(base + 14_000);
    base += 20_000;
  }
  await wait(base);
  stop = true;
  await sampler;
  for (const guest of guests) await guest.shot(join(out, `end-${guest.key}-${guest.kind}.png`)).catch(() => undefined);
  for (const guest of guests) {
    const state = await guest.ev(`({ unified: __deaf.unified, providers: [...new Set(__rehearsal.grants.map((g) => g.provider))] })`).catch(() => ({}));
    guest.state = state;
  }
} finally {
  for (const guest of guests) await guest.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  for (const child of children) child.kill();
  if (spaceRef) {
    await call("POST", `${tenant}/spaces/${spaceRef.space}/episodes/${spaceRef.episode}/end`, {}).catch((e) => console.log(`end failed: ${e.message}`));
    await call("POST", `${tenant}/spaces/${spaceRef.space}/archive`, {}).catch((e) => console.log(`archive failed: ${e.message}`));
  }
  writeFileSync(join(out, "timeline.json"), JSON.stringify(timeline));
}

// Summary. A new key (ssrc or source track) that first shows up mid-window starts from zero, as the Orb probe does.
const gain = (rows, pick) => {
  const first = new Map();
  const last = new Map();
  for (const [i, row] of rows.entries()) {
    for (const x of pick(row)) {
      const key = x.ssrc ?? x.tid;
      if (!first.has(key)) first.set(key, i === 0 ? x : { ...x, pk: 0, by: 0, en: 0 });
      last.set(key, x);
    }
  }
  let g = { pk: 0, by: 0, en: 0 };
  for (const [key, v] of last) g = { pk: g.pk + (v.pk ?? 0) - (first.get(key).pk ?? 0), by: g.by + (v.by ?? 0) - (first.get(key).by ?? 0), en: g.en + (v.en ?? 0) - first.get(key).en };
  return g;
};
const kindOf = Object.fromEntries(guests.map((g) => [g.key, g.kind]));
const nearest = (rows, t) => rows.reduce((best, r) => (best === undefined || Math.abs(r.t - t) < Math.abs(best.t - t) ? r : best), undefined);
const summary = actions.map((a) => {
  const observer = a.who === "A" ? "B" : "A";
  const win = (who) => timeline.filter((r) => r.who === who && !r.error && r.t >= a.on + 4000 && r.t <= a.on + 14_000);
  const sender = win(a.who);
  const recv = win(observer);
  const head = { cycle: a.cycle, sender: `${a.who}(${kindOf[a.who]})`, observer: `${observer}(${kindOf[observer]})` };
  if (!sender.length || !recv.length) return { ...head, verdict: "NO-DATA" };
  const sSrc = gain(sender, (r) => r.src);
  const rIn = gain(recv, (r) => r.inA);
  const verdict = sSrc.en <= 0.001 ? "RIG-SENDER-SILENT" : rIn.pk <= 0 ? "NO-PACKETS" : rIn.en <= 0.001 ? "DEAF" : "HEARS";
  const at5 = nearest(
    timeline.filter((r) => r.who === observer && !r.error),
    a.on + 5000,
  );
  const rx = at5.trans.filter((t) => t.rk === "audio").map((t) => `mid${t.mid}:${t.dir}/${t.cur}:rcv=${t.rrs}${t.rmuted ? "(muted)" : ""}`);
  return { ...head, verdict, senderEnergyGain: +sSrc.en.toFixed(3), observerEnergyGain: +rIn.en.toFixed(3), observerPackets: rIn.pk, observerRxAtOnPlus5s: rx, pcCountObserver: at5.pcCount };
});
const result = { ...spaceRef, first: kinds[0], second: kinds[1], unifiedSignaling: Object.fromEntries(guests.map((g) => [g.key, g.state?.unified])), providers: guests.map((g) => g.state?.providers), hears: summary.filter((s) => s.verdict === "HEARS").length, total: summary.length, summary };
writeFileSync(join(out, "summary.json"), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
