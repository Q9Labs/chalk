#!/usr/bin/env node
// Joins a call on a device again and again with the camera on and records whether the camera keeps sending: the encoded
// frame count of the Participant's own video sender, sampled every second for --seconds, per iteration.
// A sender whose encoder stops while the camera track is live shows as `stalled`.
//
//   node .agents/skills/verify-chalk/scripts/camera-soak.mjs <run-id> --device ipad [--iterations 20] [--seconds 25] [--camera 1280x720] [--encodings sdk|fixture]  (sdk, the default, publishes with the SDK's own layers; fixture replaces them with a fixed set and bypasses the uplink policy)
import { runJourney } from "./journey.mjs";

const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const device = option("device", "ipad");
const iterations = Number(option("iterations", "20"));
const seconds = Number(option("seconds", "25"));
const [width, height] = option("camera", "1280x720").split("x").map(Number);
if (!Number.isInteger(iterations) || iterations < 1) throw new Error("--iterations must be a whole number of at least 1");
const encodings = option("encodings", "sdk");

// Runs in the page: what the sender is doing right now.
async function senderState() {
  const reports = await Promise.all(window.proofConnections.map((connection) => connection.getStats()));
  const rows = reports.flatMap((report) => [...report.values()]);
  const video = rows.filter((row) => row.type === "outbound-rtp" && row.kind === "video");
  const pair = rows.find((row) => row.type === "candidate-pair" && (row.nominated || row.selected) && row.state === "succeeded");
  const source = rows.find((row) => row.type === "media-source" && row.kind === "video");
  const senders = window.proofConnections.flatMap((connection) => connection.getSenders()).filter((sender) => sender.track?.kind === "video");
  return {
    encoded: video.reduce((sum, row) => sum + (row.framesEncoded ?? 0), 0),
    sent: video.reduce((sum, row) => sum + (row.bytesSent ?? 0), 0),
    layers: video.map((row) => `${row.rid ?? "-"}:${row.frameWidth ?? 0}x${row.frameHeight ?? 0}@${row.framesPerSecond ?? 0}:${row.qualityLimitationReason ?? "?"}`),
    sourceFrames: source?.frames ?? null,
    bandwidth: pair?.availableOutgoingBitrate ?? null,
    encodings: senders.flatMap((sender) => sender.getParameters().encodings.map((encoding) => `${encoding.rid ?? "-"}:${encoding.active}`)),
    trackLive: senders.map((sender) => sender.track.readyState),
  };
}

await runJourney(`camera-soak-${device}`, async ({ step, person, startCall }) => {
  const host = await person("SoakHost", 1, { record: false });
  let link;
  await step("the host starts the call", async () => {
    ({ link } = await startCall(host));
  });
  for (let run = 1; run <= iterations; run++) {
    await step(`join ${run} with the camera on`, async () => {
      const me = await person(`Soak-${run}`, 2, { device, camera: { width, height }, encodings, record: false });
      try {
        await me.page.goto(link);
        const join = me.page.getByRole("button", { name: "Join call", exact: true });
        const name = me.page.getByLabel("Your name", { exact: true });
        for (let attempt = 0; attempt < 20 && !(await join.isEnabled()); attempt++) {
          await name.fill(me.name);
          await me.page.waitForTimeout(250);
        }
        const sheet = me.page.getByRole("dialog", { name: "Camera and microphone" });
        await sheet.waitFor({ timeout: 15_000 });
        await sheet.getByRole("button", { name: "Turn on", exact: true }).click();
        await sheet.waitFor({ state: "detached", timeout: 15_000 });
        await join.click();
        await me.page.getByRole("button", { name: `Video tile for ${me.name}`, exact: true }).waitFor({ timeout: 60_000 });
        const samples = [];
        for (let second = 0; second < seconds; second++) {
          await me.page.waitForTimeout(1000);
          samples.push({ second, ...(await me.page.evaluate(senderState)) });
        }
        const last = samples.at(-1);
        const earlier = samples.at(-11) ?? samples[0];
        const stalled = last.encoded - earlier.encoded < 5;
        const verdict = { run, stalled, encodedAtEnd: last.encoded, gainLast10s: last.encoded - earlier.encoded, layers: last.layers, encodings: last.encodings, bandwidth: last.bandwidth, trackLive: last.trackLive, firstFrameSecond: samples.find((sample) => sample.encoded > 0)?.second ?? null };
        if (stalled) throw new Error(`stalled: ${JSON.stringify({ ...verdict, timeline: samples.map((sample) => `${sample.second}:${sample.encoded}/${sample.sourceFrames}`).join(" ") })}`);
        return verdict;
      } finally {
        await me.context.close();
      }
    }).catch(() => undefined);
  }
});
