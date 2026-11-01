// Shared pieces of the Cloudflare-only scripts: REST calls and a Chromium page that owns RTCPeerConnections.
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const credentials = JSON.parse(await readFile(process.env.CF_CREDENTIALS || "/tmp/sr-creds.json", "utf8"));
const base = `https://rtc.live.cloudflare.com/v1/apps/${credentials.appId}`;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const maxInFlight = Number(process.env.CF_MAX_REQUESTS || 6);
let inFlight = 0;
const waiting = [];
const acquire = () => {
  if (inFlight < maxInFlight) {
    inFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
};
const release = () => {
  const next = waiting.shift();
  if (next) next();
  else inFlight -= 1;
};

export async function sfu(method, path, body) {
  const started = Date.now();
  let response;
  // A connect timeout means the request never reached Cloudflare, so repeating it is safe.
  // The box's egress drops new connections when too many open at once, so cap the requests in flight.
  for (let attempt = 1; ; attempt++) {
    await acquire();
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${credentials.appSecret}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      break;
    } catch (error) {
      if (attempt === 5 || error?.cause?.code !== "UND_ERR_CONNECT_TIMEOUT") throw error;
    } finally {
      release();
    }
  }
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
    // Resolves when the peer is connected, and returns how long that took.
    async connected(id, ms) {
      const pc = peers.get(id);
      const start = Date.now();
      while (Date.now() - start < ms) {
        if (pc.connectionState === "connected") return Date.now() - start;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return null;
    },
    state(id) {
      const pc = peers.get(id);
      return { connection: pc.connectionState, ice: pc.iceConnectionState };
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

export const launchOptions = {
  headless: true,
  executablePath: process.env.CF_CHROMIUM || "/usr/bin/chromium",
  args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
};

export const launchBrowser = () => chromium.launch(launchOptions);

export async function newPage(browser) {
  const context = await browser.newContext();
  // getUserMedia needs a secure context, and localhost is one.
  await context.route("http://localhost/", (route) => route.fulfill({ contentType: "text/html", body: "<title>cf</title>" }));
  const page = await context.newPage();
  await page.goto("http://localhost/");
  await page.evaluate(pageSetup);
  return page;
}
