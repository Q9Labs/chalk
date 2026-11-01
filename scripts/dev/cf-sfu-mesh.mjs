// Cloudflare Realtime SFU on its own, shaped like our client: no Chalk SDK, API or Sync.
// Every participant has ONE session and one peer that both publishes its microphone and pulls everyone else
// (the SDK's shape: pulls and publishes use the same connection id). All pairs hear each other.
// Then the harness kill hits CF_KILLS participants: every track of the session (published and pulled) is
// force-closed over REST. Each killed participant rebuilds on a new session (new track name), and every
// participant pulls the new tracks, retrying once a second like the listener reconcile loop.
// Logs per pair: time from the kill until RTP flows again, plus every per-track errorCode.
// Env: CF_N (default 6), CF_KILLS (default 4), CF_KILL_GAP_MS (700), CF_REBUILD_DELAY_MS (1500),
// CF_WATCH_S (90), CF_RUNS (3), CF_OUTPUT, CF_CREDENTIALS, CF_CHROMIUM.
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const credentials = JSON.parse(await readFile(process.env.CF_CREDENTIALS || "/tmp/sr-creds.json", "utf8"));
const base = `https://rtc.live.cloudflare.com/v1/apps/${credentials.appId}`;
const participantCount = Number(process.env.CF_N || 6);
const killCount = Number(process.env.CF_KILLS || 4);
const killGapMs = Number(process.env.CF_KILL_GAP_MS || 700);
const rebuildDelayMs = Number(process.env.CF_REBUILD_DELAY_MS || 1500);
const watchSeconds = Number(process.env.CF_WATCH_S || 90);
const runs = Number(process.env.CF_RUNS || 3);
// CF_ANNOUNCE=early announces a new track as soon as addTracks answers, before the publisher's ICE connects
// (what the SDK does); the default announces after it connects. CF_PULL_MS is the pull retry period (1000).
const announceEarly = process.env.CF_ANNOUNCE === "early";
const pullMs = Number(process.env.CF_PULL_MS || 1000);
// CF_PULL_DELAY_MS keeps listeners from pulling a track until this long after its announcement.
const pullDelayMs = Number(process.env.CF_PULL_DELAY_MS || 0);
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
        if (!transceiver.mid || transceiver.direction === "sendonly") continue;
        for (const report of (await transceiver.receiver.getStats()).values()) {
          if (report.type === "inbound-rtp") result[transceiver.mid] = report.packetsReceived;
        }
      }
      return result;
    },
    async sent(id) {
      for (const report of (await peers.get(id).getStats()).values()) {
        if (report.type === "outbound-rtp") return { packets: report.packetsSent, bytes: report.bytesSent };
      }
      return null;
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

async function newPage(browser) {
  const context = await browser.newContext();
  await context.route("http://localhost/", (route) => route.fulfill({ contentType: "text/html", body: "<title>cf</title>" }));
  const page = await context.newPage();
  await page.goto("http://localhost/");
  await page.evaluate(pageSetup);
  return page;
}

// One participant: a page, a current session and peer, and what it pulled on that session.
class Participant {
  constructor(index, page, clock) {
    this.index = index;
    this.page = page;
    this.clock = clock;
    this.generation = 0;
    this.queue = Promise.resolve();
    this.pulled = new Map(); // key "sessionId/trackName" -> { mid, pulledAt, baseline, heardAt }
    this.errors = new Map(); // key -> [{ atMs, code, description, ms }]
  }

  // The SDK queues SDP exchanges per connection, so a pull never overlaps a publish.
  serialize(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  publish(trackName, onPushed) {
    return this.serialize(() => this.publishNow(trackName, onPushed));
  }

  pullWanted(wanted) {
    return this.serialize(() => this.pullNow(wanted));
  }

  async publishNow(trackName, onPushed) {
    const session = await sfu("POST", "/sessions/new");
    this.sessionId = session.json.sessionId;
    this.peer = await this.page.evaluate(() => window.cf.newPeer());
    this.pulled = new Map();
    this.generation += 1;
    const offer = await this.page.evaluate((id) => window.cf.publishOffer(id), this.peer);
    const pushed = await sfu("POST", `/sessions/${this.sessionId}/tracks/new`, {
      sessionDescription: { type: "offer", sdp: offer.sdp },
      tracks: [{ location: "local", mid: offer.mid, trackName }],
    });
    if (!pushed.json?.sessionDescription) throw new Error(`push failed ${pushed.status} ${pushed.text}`);
    onPushed?.();
    await this.page.evaluate(({ id, sdp }) => window.cf.setAnswer(id, sdp), { id: this.peer, sdp: pushed.json.sessionDescription.sdp });
    if (!(await this.page.evaluate((id) => window.cf.connected(id, 20000), this.peer))) throw new Error("publisher did not connect");
    this.trackName = trackName;
    this.mid = offer.mid;
  }

  // One batched pull of every wanted track this session does not hold yet, answered at once.
  async pullNow(wanted) {
    if (!this.sessionId || !this.trackName) return;
    const generation = this.generation;
    const missing = wanted.filter((target) => !this.pulled.has(`${target.sessionId}/${target.trackName}`));
    if (missing.length === 0) return;
    const response = await sfu("POST", `/sessions/${this.sessionId}/tracks/new`, {
      tracks: missing.map((target) => ({ location: "remote", sessionId: target.sessionId, trackName: target.trackName })),
    });
    if (generation !== this.generation) return;
    const atMs = this.clock();
    const byName = new Map((response.json?.tracks ?? []).map((track) => [track.trackName, track]));
    let ok = false;
    for (const target of missing) {
      const key = `${target.sessionId}/${target.trackName}`;
      const track = byName.get(target.trackName);
      const code = track?.errorCode ?? response.json?.errorCode ?? (response.status >= 300 ? `http_${response.status}` : null);
      if (code || !track?.mid) {
        const list = this.errors.get(key) ?? [];
        list.push({ atMs, code: code ?? "no_track_in_response", description: (track?.errorDescription ?? response.json?.errorDescription ?? response.text).slice(0, 80), ms: response.ms });
        this.errors.set(key, list);
        continue;
      }
      ok = true;
      this.pulled.set(key, { mid: track.mid, pulledAt: atMs, baseline: null, heardAt: null });
    }
    if (ok && response.json?.requiresImmediateRenegotiation && response.json.sessionDescription) {
      const answer = await this.page.evaluate(({ id, sdp }) => window.cf.answerOffer(id, sdp), { id: this.peer, sdp: response.json.sessionDescription.sdp });
      await sfu("PUT", `/sessions/${this.sessionId}/renegotiate`, { sessionDescription: { type: "answer", sdp: answer } });
    }
  }

  async watchRtp() {
    const generation = this.generation;
    const packets = await this.page.evaluate((id) => window.cf.packets(id), this.peer).catch(() => ({}));
    if (generation !== this.generation) return;
    for (const entry of this.pulled.values()) {
      if (entry.heardAt !== null || !(entry.mid in packets)) continue;
      entry.baseline ??= packets[entry.mid];
      if (packets[entry.mid] > entry.baseline + 5) entry.heardAt = this.clock();
    }
  }
}

async function oneRun(runIndex) {
  const started = Date.now();
  const clock = () => Date.now() - started;
  const browser = await chromium.launch(launchOptions);
  const result = { run: runIndex, events: [] };
  try {
    const participants = [];
    for (let index = 0; index < participantCount; index++) participants.push(new Participant(index, await newPage(browser), clock));
    // Current published track of each participant, as the registry would announce it.
    const published = participants.map(() => null);
    const publishNew = async (participant, label) => {
      const name = `mesh-${runIndex}-${participant.index}-${label}-${Date.now()}`;
      const announce = () => {
        published[participant.index] = { sessionId: participant.sessionId, trackName: name, announcedAt: clock() };
      };
      await participant.publish(name, announceEarly ? announce : undefined);
      if (!announceEarly) announce();
    };
    for (const participant of participants) await publishNew(participant, "first");

    const wantedFor = (participant) => published.filter((entry, index) => index !== participant.index && entry && clock() - entry.announcedAt >= pullDelayMs).map((entry) => ({ sessionId: entry.sessionId, trackName: entry.trackName }));
    let running = true;
    const loops = participants.map(async (participant) => {
      while (running) {
        await participant.pullWanted(wantedFor(participant)).catch((error) => result.events.push({ atMs: clock(), participant: participant.index, error: String(error.message).slice(0, 120) }));
        await sleep(pullMs);
      }
    });
    const rtpLoop = (async () => {
      while (running) {
        await Promise.all(participants.map((participant) => participant.watchRtp()));
        await sleep(250);
      }
    })();

    // Wait until every pair hears every other.
    const allHeard = () => participants.every((participant) => {
      const wanted = wantedFor(participant);
      return wanted.every((target) => participant.pulled.get(`${target.sessionId}/${target.trackName}`)?.heardAt != null);
    });
    for (let waited = 0; !allHeard() && waited < 40000; waited += 250) await sleep(250);
    result.steadyAtMs = clock();
    result.steady = allHeard();
    if (!result.steady) {
      result.invalid = "not every pair heard before the kill";
      running = false;
      await Promise.all(loops);
      return result;
    }
    await sleep(3000);

    // The kill: force-close every track of each session, then rebuild after a delay.
    const kills = [];
    const rebuilds = [];
    for (let k = 0; k < killCount; k++) {
      const victim = participants[k];
      await sleep(k === 0 ? 0 : killGapMs);
      const killedSession = victim.sessionId;
      const listing = await sfu("GET", `/sessions/${killedSession}`);
      const mids = (listing.json?.tracks ?? []).filter((track) => track.mid).map((track) => ({ mid: track.mid }));
      const closed = await sfu("PUT", `/sessions/${killedSession}/tracks/close`, { tracks: mids, force: true });
      const killAt = clock();
      kills.push({ participant: victim.index, killAt, tracksClosed: mids.length, status: closed.status });
      rebuilds.push((async () => {
        await sleep(rebuildDelayMs);
        const oldPeer = victim.peer;
        await publishNew(victim, "again");
        victim.page.evaluate((id) => window.cf.close(id), oldPeer).catch(() => undefined);
        kills[k].rebuiltAtMs = clock();
      })());
    }
    await Promise.all(rebuilds);
    const lastKillAt = kills.at(-1).killAt;

    // Watch until all pairs hear the new tracks or the time is up.
    const killedIndexes = new Set(kills.map((kill) => kill.participant));
    const healed = () => participants.every((participant) => wantedFor(participant).every((target) => participant.pulled.get(`${target.sessionId}/${target.trackName}`)?.heardAt != null));
    while (clock() - lastKillAt < watchSeconds * 1000 && !healed()) await sleep(500);
    running = false;
    await Promise.all(loops);
    await rtpLoop;

    const pairs = [];
    for (const listener of participants) {
      for (const target of wantedFor(listener)) {
        const speakerIndex = published.findIndex((entry) => entry?.trackName === target.trackName);
        const involved = killedIndexes.has(speakerIndex) || killedIndexes.has(listener.index);
        if (!involved) continue;
        const key = `${target.sessionId}/${target.trackName}`;
        const entry = listener.pulled.get(key);
        const errors = listener.errors.get(key) ?? [];
        const kill = kills.find((item) => item.participant === speakerIndex) ?? kills.find((item) => item.participant === listener.index);
        const readyAt = Math.max(published[speakerIndex].announcedAt, kills.find((item) => item.participant === listener.index)?.rebuiltAtMs ?? 0);
        pairs.push({
          listener: listener.index,
          speaker: speakerIndex,
          listenerKilled: killedIndexes.has(listener.index),
          speakerKilled: killedIndexes.has(speakerIndex),
          healMsAfterKill: entry?.heardAt != null ? entry.heardAt - kill.killAt : null,
          healMsAfterBothReady: entry?.heardAt != null ? entry.heardAt - readyAt : null,
          pullFailures: errors.length,
          errorCodes: [...new Set(errors.map((error) => `${error.code}:${error.description}`))],
          firstFailureAtMs: errors[0]?.atMs ?? null,
          lastFailureAtMs: errors.at(-1)?.atMs ?? null,
        });
      }
    }
    // Probe every track nobody could pull: what Cloudflare reports, whether the publisher sends, and whether a new listener can pull it.
    result.stuck = [];
    for (const speaker of participants) {
      const entry = published[speaker.index];
      if (!entry || participants.some((listener) => listener !== speaker && listener.pulled.get(`${entry.sessionId}/${entry.trackName}`)?.heardAt != null)) continue;
      const before = await speaker.page.evaluate((id) => window.cf.sent(id), speaker.peer);
      await sleep(2000);
      const after = await speaker.page.evaluate((id) => window.cf.sent(id), speaker.peer);
      const listing = await sfu("GET", `/sessions/${entry.sessionId}`);
      const probe = new Participant(-1, participants[0].page, clock);
      await probe.publish(`probe-${Date.now()}`);
      await probe.pullWanted([{ sessionId: entry.sessionId, trackName: entry.trackName }]);
      const probeKey = `${entry.sessionId}/${entry.trackName}`;
      for (let waited = 0; waited < 6000 && probe.pulled.get(probeKey)?.heardAt == null && !probe.pulled.has(probeKey); waited += 1000) {
        await sleep(1000);
        await probe.pullWanted([{ sessionId: entry.sessionId, trackName: entry.trackName }]);
      }
      for (let waited = 0; waited < 4000 && probe.pulled.get(probeKey)?.heardAt == null; waited += 250) {
        await probe.watchRtp();
        await sleep(250);
      }
      result.stuck.push({
        speaker: speaker.index,
        sendingPacketsIn2s: before && after ? after.packets - before.packets : null,
        sessionTracks: (listing.json?.tracks ?? []).map((track) => ({ mid: track.mid, status: track.status, trackName: track.trackName === entry.trackName ? "same" : track.trackName })),
        freshListener: { pulled: probe.pulled.has(probeKey), heard: probe.pulled.get(probeKey)?.heardAt != null, errors: (probe.errors.get(probeKey) ?? []).map((error) => error.code).slice(-1) },
      });
    }
    result.kills = kills;
    result.pairs = pairs;
    return result;
  } catch (error) {
    result.error = String(error?.stack ?? error).slice(0, 600);
    return result;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

const results = [];
for (let index = 0; index < runs; index++) {
  const run = await oneRun(index);
  results.push(run);
  const pairs = run.pairs ?? [];
  const heals = pairs.map((pair) => pair.healMsAfterBothReady).filter((value) => value !== null).sort((a, b) => a - b);
  console.log(JSON.stringify({
    run: index, invalid: run.invalid, error: run.error, pairs: pairs.length, healed: heals.length,
    healAfterReadyMsP50: heals[Math.floor(heals.length / 2)] ?? null, healAfterReadyMsMax: heals.at(-1) ?? null,
    pairsWithFailures: pairs.filter((pair) => pair.pullFailures > 0).length,
    errorCodes: [...new Set(pairs.flatMap((pair) => pair.errorCodes))],
    stuckTracks: run.stuck?.length ?? null,
    stuck: process.env.CF_VERBOSE ? run.stuck : undefined,
  }));
  await writeFile(process.env.CF_OUTPUT || "/tmp/cf-mesh.json", JSON.stringify(results, null, 1));
}
