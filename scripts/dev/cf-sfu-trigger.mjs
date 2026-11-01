// What makes a track unpullable at Cloudflare? Cloudflare REST only, real Chromium peers.
// Mode e1: one publisher plus CF_LISTENERS listeners (each with its own session) per trial. The listeners pull on a schedule
// that starts before or after the publisher connects. A trial is stuck when no listener hears the track within CF_WAIT_S
// after the publisher connected.
//   late          first pull after connect, then every 300 ms
//   early-single  one pull when addTracks answers (before connect), then nothing until connect, then every 300 ms
//   early-300     pull when addTracks answers, retry every 300 ms
//   early-2000    pull when addTracks answers, retry every 2 s
// Mode e2: poll GET /sessions/{publisher} every 100 ms from addTracks until 3 s after connect and print each change.
// Env: CF_MODE (e1|e2), CF_VARIANTS, CF_TRIALS (publishers per batch, 8), CF_BATCHES (3), CF_LISTENERS (5), CF_WAIT_S (20),
// CF_OUTPUT, CF_CREDENTIALS, CF_CHROMIUM.
import { writeFile } from "node:fs/promises";
import { launchBrowser, newPage, sfu, sleep } from "./cf-sfu-lib.mjs";

const mode = process.env.CF_MODE || "e1";
const trialsPerBatch = Number(process.env.CF_TRIALS || 8);
const batches = Number(process.env.CF_BATCHES || 3);
const listenersPerTrial = Number(process.env.CF_LISTENERS || 5);
const waitSeconds = Number(process.env.CF_WAIT_S || 20);
const schedules = {
  late: { first: "connected", before: null, after: 300 },
  "early-single": { first: "push", before: null, after: 300 },
  "early-300": { first: "push", before: 300, after: 300 },
  "early-2000": { first: "push", before: 2000, after: 2000 },
};

// Resolves once, with a way to read whether it has.
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve, done: false };
};

async function startPublisher(page, trackName) {
  const session = await sfu("POST", "/sessions/new");
  const sessionId = session.json.sessionId;
  const peer = await page.evaluate(() => window.cf.newPeer());
  const offer = await page.evaluate((id) => window.cf.publishOffer(id), peer);
  const pushed = await sfu("POST", `/sessions/${sessionId}/tracks/new`, {
    sessionDescription: { type: "offer", sdp: offer.sdp },
    tracks: [{ location: "local", mid: offer.mid, trackName }],
  });
  if (!pushed.json?.sessionDescription) throw new Error(`push failed ${pushed.status} ${pushed.text}`);
  return { sessionId, peer, mid: offer.mid, trackName, pushedAt: Date.now(), answer: pushed.json.sessionDescription.sdp };
}

async function connectPublisher(page, publisher, started) {
  await page.evaluate(({ id, sdp }) => window.cf.setAnswer(id, sdp), { id: publisher.peer, sdp: publisher.answer });
  const took = await page.evaluate((id) => window.cf.connected(id, 30000), publisher.peer);
  if (took === null) throw new Error("publisher did not connect");
  publisher.connectedAt = Date.now();
  publisher.connectMs = publisher.connectedAt - publisher.pushedAt;
  return started;
}

async function listener(page, publisher, schedule, connected, deadlineAt) {
  const session = await sfu("POST", "/sessions/new");
  const peer = await page.evaluate(() => window.cf.newPeer());
  const outcome = { pulls: 0, failures: 0, codes: {}, heardAfterConnectMs: null, firstPullAtMs: null };
  let mid = null;
  let baseline = null;
  const pullOnce = async () => {
    outcome.pulls += 1;
    outcome.firstPullAtMs ??= Date.now() - publisher.pushedAt;
    const response = await sfu("POST", `/sessions/${session.json.sessionId}/tracks/new`, {
      tracks: [{ location: "remote", sessionId: publisher.sessionId, trackName: publisher.trackName }],
    });
    const track = response.json?.tracks?.[0];
    const code = track?.errorCode ?? response.json?.errorCode;
    if (code || !track?.mid) {
      outcome.failures += 1;
      outcome.codes[code ?? `http_${response.status}`] = (outcome.codes[code ?? `http_${response.status}`] ?? 0) + 1;
      return;
    }
    mid = track.mid;
    if (response.json.requiresImmediateRenegotiation && response.json.sessionDescription) {
      const answer = await page.evaluate(({ id, sdp }) => window.cf.answerOffer(id, sdp), { id: peer, sdp: response.json.sessionDescription.sdp });
      await sfu("PUT", `/sessions/${session.json.sessionId}/renegotiate`, { sessionDescription: { type: "answer", sdp: answer } });
    }
  };
  if (schedule.first === "connected") await connected.promise;
  while (Date.now() < deadlineAt() && outcome.heardAfterConnectMs === null) {
    if (mid === null) await pullOnce();
    if (mid !== null) {
      const packets = (await page.evaluate((id) => window.cf.packets(id), peer))[mid];
      if (packets !== undefined) {
        baseline ??= packets;
        if (packets > baseline + 5) outcome.heardAfterConnectMs = Math.max(0, Date.now() - (publisher.connectedAt ?? Date.now()));
      }
      await sleep(200);
      continue;
    }
    if (!connected.done && schedule.before === null) {
      await Promise.race([connected.promise, sleep(60000)]);
    } else {
      await sleep(connected.done ? schedule.after : schedule.before);
    }
  }
  page.evaluate((id) => window.cf.close(id), peer).catch(() => undefined);
  return outcome;
}

async function trial(page, variant, index) {
  const schedule = schedules[variant];
  const connected = deferred();
  const publisher = await startPublisher(page, `trigger-${variant}-${index}-${Date.now()}`);
  let deadline = Date.now() + 60000;
  const listeners = Array.from({ length: listenersPerTrial }, () => listener(page, publisher, schedule, connected, () => deadline));
  await connectPublisher(page, publisher);
  connected.done = true;
  connected.resolve();
  deadline = publisher.connectedAt + waitSeconds * 1000;
  const outcomes = await Promise.all(listeners);
  const heard = outcomes.filter((outcome) => outcome.heardAfterConnectMs !== null);
  page.evaluate((id) => window.cf.close(id), publisher.peer).catch(() => undefined);
  return {
    variant,
    connectMs: publisher.connectMs,
    stuck: heard.length === 0,
    heardListeners: heard.length,
    firstHeardMs: heard.length ? Math.min(...heard.map((outcome) => outcome.heardAfterConnectMs)) : null,
    pullsBeforeConnect: null,
    outcomes,
  };
}

async function runE1() {
  const results = [];
  const browser = await launchBrowser();
  try {
    const page = await newPage(browser);
    for (const variant of (process.env.CF_VARIANTS || "late,early-single,early-300,early-2000").split(",")) {
      const trials = [];
      for (let batch = 0; batch < batches; batch++) {
        trials.push(...(await Promise.all(Array.from({ length: trialsPerBatch }, (_, index) => trial(page, variant, batch * trialsPerBatch + index).catch((error) => ({ variant, error: String(error.message) }))))));
      }
      results.push(...trials);
      const valid = trials.filter((item) => !item.error);
      const connectTimes = valid.map((item) => item.connectMs).sort((a, b) => a - b);
      const failedPulls = valid.filter((item) => item.outcomes.some((outcome) => outcome.failures > 0)).length;
      console.log(
        JSON.stringify({
          variant,
          trials: trials.length,
          errors: trials.length - valid.length,
          stuck: valid.filter((item) => item.stuck).length,
          withAnyFailedPull: failedPulls,
          partial: valid.filter((item) => !item.stuck && item.heardListeners < listenersPerTrial).length,
          connectMsP50: connectTimes[Math.floor(connectTimes.length / 2)],
          connectMsMax: connectTimes.at(-1),
          stuckConnectMs: valid.filter((item) => item.stuck).map((item) => item.connectMs),
        }),
      );
      await writeFile(process.env.CF_OUTPUT || "/tmp/cf-trigger.json", JSON.stringify(results, null, 1));
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

// E2: does anything in GET /sessions/{id} change when the publisher's peer connects?
async function runE2() {
  const browser = await launchBrowser();
  const report = [];
  try {
    const page = await newPage(browser);
    for (let index = 0; index < Number(process.env.CF_TRIALS || 6); index++) {
      const publisher = await startPublisher(page, `e2-${index}-${Date.now()}`);
      const timeline = [];
      let last = "";
      let connectedAt = null;
      let polling = true;
      let firstPacketAt = null;
      const poll = (async () => {
        while (polling) {
          const at = Date.now() - publisher.pushedAt;
          const listing = await sfu("GET", `/sessions/${publisher.sessionId}`);
          const sent = await page.evaluate((id) => window.cf.sent(id), publisher.peer).catch(() => null);
          if (sent?.packets > 0 && firstPacketAt === null) firstPacketAt = Date.now() - publisher.pushedAt;
          const body = JSON.stringify(listing.json ?? listing.text);
          if (body !== last || listing.status !== 200) {
            last = body;
            timeline.push({ atMs: at, status: listing.status, body: JSON.parse(body) });
          }
          await sleep(100);
        }
      })();
      await connectPublisher(page, publisher);
      connectedAt = publisher.connectMs;
      await sleep(3000);
      polling = false;
      await poll;
      const early = await sfu("POST", `/sessions/${(await sfu("POST", "/sessions/new")).json.sessionId}/tracks/new`, { tracks: [{ location: "remote", sessionId: publisher.sessionId, trackName: publisher.trackName }] });
      report.push({ index, connectedAtMs: connectedAt, firstPacketSentAtMs: firstPacketAt, changes: timeline.length, timeline, pullAfterConnect: early.json?.tracks?.[0]?.errorCode ?? "ok" });
      page.evaluate((id) => window.cf.close(id), publisher.peer).catch(() => undefined);
      console.log(JSON.stringify({ index, connectedAtMs: connectedAt, firstPacketSentAtMs: firstPacketAt, changes: timeline.map((entry) => ({ atMs: entry.atMs, status: entry.status, tracks: entry.body?.tracks?.map((track) => `${track.mid}:${track.status}`) })) }));
    }
    await writeFile(process.env.CF_OUTPUT || "/tmp/cf-e2.json", JSON.stringify(report, null, 1));
  } finally {
    await browser.close().catch(() => undefined);
  }
}

if (mode === "e2") await runE2();
else await runE1();
