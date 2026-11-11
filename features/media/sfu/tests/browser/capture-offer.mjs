// Captures a real Chromium offer the way the SDK builds one: a microphone and a simulcast camera
// that send, plus a receive-only audio and video section for each remote guest, most of them
// closed (inactive) after the call opened them. Chromium answers its own offer through a second
// connection in the same page, so the second offer carries the negotiated sections.
// Run from features/media/sfu: GUESTS=7 node tests/browser/capture-offer.mjs > offer.sdp
// The output is sanitized: session id, ICE credentials, fingerprint, cname and msid ids are replaced,
// and candidate lines are dropped.
import { chromium } from "playwright";

const guests = Number(process.env.GUESTS ?? 7);
const liveGuests = Number(process.env.LIVE_GUESTS ?? 1);

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  const raw = await page.evaluate(
    async ({ guests, liveGuests }) => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      canvas.getContext("2d").fillRect(0, 0, 640, 360);
      const camera = canvas.captureStream(15).getVideoTracks()[0];
      const microphone = new AudioContext().createMediaStreamDestination().stream.getAudioTracks()[0];

      const connection = new RTCPeerConnection();
      const answerer = new RTCPeerConnection();
      connection.addTransceiver(microphone, { direction: "sendonly" });
      connection.addTransceiver(camera, {
        direction: "sendonly",
        sendEncodings: [{ rid: "q", scaleResolutionDownBy: 4 }, { rid: "h", scaleResolutionDownBy: 2 }, { rid: "f" }],
      });
      const remote = [];
      for (let guest = 0; guest < guests; guest += 1) {
        remote.push([connection.addTransceiver("audio", { direction: "recvonly" }), connection.addTransceiver("video", { direction: "recvonly" })]);
      }
      const exchange = async () => {
        await connection.setLocalDescription(await connection.createOffer());
        await answerer.setRemoteDescription(connection.localDescription);
        await answerer.setLocalDescription(await answerer.createAnswer());
        await connection.setRemoteDescription(answerer.localDescription);
      };
      await exchange();
      remote.forEach((sections, index) => {
        if (index >= liveGuests) sections.forEach((section) => (section.direction = "inactive"));
      });
      const offer = await connection.createOffer();
      connection.close();
      answerer.close();
      return offer.sdp;
    },
    { guests, liveGuests },
  );

  const names = new Map();
  const stable = (value, prefix) => {
    if (!names.has(value)) names.set(value, `${prefix}${names.size}`);
    return names.get(value);
  };
  const sanitized = raw
    .replace(/^a=(candidate|end-of-candidates).*\r\n/gm, "")
    .replace(/^o=- \d+ (\d+) IN IP4 127\.0\.0\.1$/m, "o=- 4611686018427387904 $1 IN IP4 127.0.0.1")
    .replace(/^a=ice-ufrag:.*$/gm, "a=ice-ufrag:fixt")
    .replace(/^a=ice-pwd:.*$/gm, "a=ice-pwd:fixturefixturefixturefixture")
    .replace(/^a=fingerprint:sha-256 .*$/gm, `a=fingerprint:sha-256 ${Array(32).fill("AA").join(":")}`)
    .replace(/cname:(\S+)/g, (_, value) => `cname:${stable(value, "fixture-cname-")}`)
    .replace(/^(a=msid:)(\S+) (\S+)$/gm, (_, key, stream, track) => `${key}${stable(stream, "fixture-stream-")} ${stable(track, "fixture-track-")}`)
    .replace(/^(a=ssrc:\d+ msid:)(\S+) (\S+)$/gm, (_, key, stream, track) => `${key}${stable(stream, "fixture-stream-")} ${stable(track, "fixture-track-")}`);
  process.stdout.write(sanitized);
} finally {
  await browser.close();
}
