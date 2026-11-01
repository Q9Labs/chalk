// Cloudflare Realtime SFU on its own: no Chalk SDK, API or Sync.
// A publishes a track and a listener pulls it. A is killed, then B (a new session) publishes and the listener
// pulls B at once and retries every second. Logs each per-track errorCode and the time until RTP flows.
//
// Cases (CF_CASES, comma list):
//   force-new   A's tracks are force-closed over REST (what silence-repro does); B uses a new track name
//   force-same  same kill; B reuses A's track name
//   peer-new    A's browser process is killed with no REST call; B uses a new track name
//   peer-same   same kill; B reuses A's track name
// Env: CF_RUNS (per case, default 3), CF_WATCH_S (default 75), CF_CREDENTIALS (default /tmp/sr-creds.json),
// CF_CHROMIUM (default /usr/bin/chromium).
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const credentials = JSON.parse(await readFile(process.env.CF_CREDENTIALS || "/tmp/sr-creds.json", "utf8"));
const base = `https://rtc.live.cloudflare.com/v1/apps/${credentials.appId}`;
const runsPerCase = Number(process.env.CF_RUNS || 3);
const watchSeconds = Number(process.env.CF_WATCH_S || 75);
const cases = (process.env.CF_CASES || "force-new,force-same,peer-new,peer-same").split(",");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sfu(method, path, body) {
  const started = Date.now();
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${credentials.appSecret}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // keep the raw text
  }
  return { status: response.status, json, text: text.slice(0, 300), ms: Date.now() - started };
}

const pageSetup = () => {
  const peers = new Map();
  let next = 0;
  window.cf = {
    newPeer() {
      const id = ++next;
      peers.set(id, new RTCPeerConnection({ bundlePolicy: "max-bundle", iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] }));
      return id;
    },
    async publishOffer(id) {
      const pc = peers.get(id);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const transceiver = pc.addTransceiver(stream.getAudioTracks()[0], { direction: "sendonly" });
      await pc.setLocalDescription(await pc.createOffer());
      return { sdp: pc.localDescription.sdp, mid: transceiver.mid };
    },
    async setAnswer(id, sdp) {
      await peers.get(id).setRemoteDescription({ type: "answer", sdp });
    },
    async answerOffer(id, sdp) {
      const pc = peers.get(id);
      await pc.setRemoteDescription({ type: "offer", sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      return pc.localDescription.sdp;
    },
    async connected(id, ms) {
      const pc = peers.get(id);
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (pc.connectionState === "connected") return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    },
    async packets(id) {
      const pc = peers.get(id);
      const result = {};
      for (const transceiver of pc.getTransceivers()) {
        if (!transceiver.mid || transceiver.currentDirection === "inactive" || transceiver.currentDirection === "sendonly") continue;
        for (const report of (await transceiver.receiver.getStats()).values()) {
          if (report.type === "inbound-rtp") result[transceiver.mid] = report.packetsReceived;
        }
      }
      return { state: pc.connectionState, packets: result };
    },
    close(id) {
      peers.get(id)?.close();
    },
  };
};

const launchOptions = {
  headless: true,
  executablePath: process.env.CF_CHROMIUM || "/usr/bin/chromium",
  args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
};
const launch = () => chromium.launch(launchOptions);

async function newPage(browser) {
  const context = await browser.newContext();
  // getUserMedia needs a secure context, and localhost is one.
  await context.route("http://localhost/", (route) => route.fulfill({ contentType: "text/html", body: "<title>cf</title>" }));
  const page = await context.newPage();
  await page.goto("http://localhost/");
  await page.evaluate(pageSetup);
  return page;
}

async function publish(page, trackName) {
  const session = await sfu("POST", "/sessions/new");
  const sessionId = session.json.sessionId;
  const peer = await page.evaluate(() => window.cf.newPeer());
  const offer = await page.evaluate((id) => window.cf.publishOffer(id), peer);
  const pushed = await sfu("POST", `/sessions/${sessionId}/tracks/new`, {
    sessionDescription: { type: "offer", sdp: offer.sdp },
    tracks: [{ location: "local", mid: offer.mid, trackName }],
  });
  if (!pushed.json?.sessionDescription) throw new Error(`push failed ${pushed.status} ${pushed.text}`);
  await page.evaluate(({ id, sdp }) => window.cf.setAnswer(id, sdp), { id: peer, sdp: pushed.json.sessionDescription.sdp });
  const ok = await page.evaluate((id) => window.cf.connected(id, 15000), peer);
  if (!ok) throw new Error("publisher did not connect");
  return { sessionId, peer, mid: offer.mid, trackName };
}

// One pull. A pull that needs renegotiation is answered at once.
async function pull(page, listener, remoteSessionId, trackName) {
  const response = await sfu("POST", `/sessions/${listener.sessionId}/tracks/new`, {
    tracks: [{ location: "remote", sessionId: remoteSessionId, trackName }],
  });
  const track = response.json?.tracks?.[0];
  const outcome = { status: response.status, ms: response.ms, errorCode: track?.errorCode ?? response.json?.errorCode ?? null, errorDescription: track?.errorDescription ?? response.json?.errorDescription ?? null, mid: track?.mid ?? null };
  if (!outcome.errorCode && response.json?.requiresImmediateRenegotiation && response.json.sessionDescription) {
    const answer = await page.evaluate(({ id, sdp }) => window.cf.answerOffer(id, sdp), { id: listener.peer, sdp: response.json.sessionDescription.sdp });
    const renegotiated = await sfu("PUT", `/sessions/${listener.sessionId}/renegotiate`, { sessionDescription: { type: "answer", sdp: answer } });
    outcome.renegotiateStatus = renegotiated.status;
  }
  return outcome;
}

async function listenerFor(page) {
  const session = await sfu("POST", "/sessions/new");
  const peer = await page.evaluate(() => window.cf.newPeer());
  return { sessionId: session.json.sessionId, peer };
}

async function rtpFlows(page, listener, mid, timeoutMs) {
  const start = Date.now();
  let first = null;
  while (Date.now() - start < timeoutMs) {
    const { packets } = await page.evaluate((id) => window.cf.packets(id), listener.peer);
    if (mid in packets) {
      first ??= packets[mid];
      if (packets[mid] > first + 5) return Date.now() - start;
    }
    await sleep(250);
  }
  return null;
}

async function oneRun(label, kill, sameName, index) {
  const result = { label, index, events: [] };
  const serverA = await chromium.launchServer(launchOptions);
  const browserA = await chromium.connect(serverA.wsEndpoint());
  const browserL = await launch();
  try {
    const pageA = await newPage(browserA);
    const pageL = await newPage(browserL);
    const nameA = `isolate-a-${Date.now()}-${index}`;
    const a = await publish(pageA, nameA);
    const listener = await listenerFor(pageL);
    const first = await pull(pageL, listener, a.sessionId, nameA);
    result.firstPull = first;
    result.firstRtpMs = first.mid ? await rtpFlows(pageL, listener, first.mid, 15000) : null;
    if (result.firstRtpMs === null) {
      result.invalid = "listener never heard A before the kill";
      return result;
    }
    await sleep(2000);

    const killedAt = Date.now();
    if (kill === "force") {
      const closed = await sfu("PUT", `/sessions/${a.sessionId}/tracks/close`, { tracks: [{ mid: a.mid }], force: true });
      result.kill = { kind: "force-close over REST", status: closed.status };
    } else {
      serverA.process().kill("SIGKILL");
      result.kill = { kind: "browser process SIGKILL, no REST call" };
    }

    // B is a new session, as our client's republish is. Publish starts one second after the kill.
    await sleep(1000);
    const nameB = sameName ? nameA : `isolate-b-${Date.now()}-${index}`;
    const b = await publish(pageL, nameB);
    const publishedAt = Date.now();
    result.publishMs = publishedAt - killedAt;
    result.nameB = sameName ? "same" : "new";

    // The listener keeps its session, as our listener does, and retries every second.
    let heardAt = null;
    let mid = null;
    let attempt = 0;
    while (Date.now() - publishedAt < watchSeconds * 1000 && heardAt === null) {
      const at = Date.now() - publishedAt;
      if (mid === null) {
        const outcome = await pull(pageL, listener, b.sessionId, nameB);
        outcome.attempt = ++attempt;
        outcome.atMs = at;
        result.events.push(outcome);
        mid = outcome.mid && !outcome.errorCode ? outcome.mid : null;
      }
      if (mid !== null) {
        const flowed = await rtpFlows(pageL, listener, mid, 1000);
        if (flowed !== null) heardAt = Date.now() - publishedAt;
      } else {
        await sleep(1000);
      }
    }
    result.heardMs = heardAt;
    const errors = new Map();
    for (const event of result.events) {
      const key = `${event.errorCode}|${(event.errorDescription ?? "").slice(0, 70)}`;
      errors.set(key, (errors.get(key) ?? 0) + 1);
    }
    result.errorSummary = Object.fromEntries(errors);
    result.firstOkAtMs = result.events.find((event) => !event.errorCode)?.atMs ?? null;
    return result;
  } catch (error) {
    result.error = String(error?.message ?? error);
    return result;
  } finally {
    await browserA.close().catch(() => undefined);
    await serverA.close().catch(() => undefined);
    await browserL.close().catch(() => undefined);
  }
}

const results = [];
for (const name of cases) {
  const [kill, which] = name.split("-");
  const runs = await Promise.all(Array.from({ length: runsPerCase }, (_, index) => oneRun(name, kill, which === "same", index)));
  for (const run of runs) {
    results.push(run);
    console.log(JSON.stringify({ case: run.label, run: run.index, heardMs: run.heardMs, firstOkAtMs: run.firstOkAtMs, attempts: run.events.length, errors: run.errorSummary, invalid: run.invalid, error: run.error }));
  }
  await writeFile(process.env.CF_OUTPUT || "/tmp/cf-isolate.json", JSON.stringify(results, null, 1));
}
