import { spawn } from "node:child_process";
import { launchGuests } from "./media.mjs";
import { createEpisode, createSpace } from "./proofs.mjs";
import { judgeDeployHold } from "./deploy-hold-criteria.mjs";
import { check, mediaPlane, save } from "./runtime.mjs";

const guestCount = 3;
const intervalMs = 1000;
const command = process.env.DEPLOY_HOLD_COMMAND;
const beforeMs = Number(process.env.DEPLOY_HOLD_BEFORE_SECONDS ?? 60) * 1000;
const afterMs = Number(process.env.DEPLOY_HOLD_AFTER_SECONDS ?? 120) * 1000;

export const deployHoldPlan = () =>
  [`Deploy hold: ${guestCount} guests on ${mediaPlane}; guest 1 sends one chat message a second.`, `After ${beforeMs / 1000}s it runs DEPLOY_HOLD_COMMAND (the deploy), holds ${afterMs / 1000}s after it exits, and fails on a rejoin, a media gap or a lost chat message.`].join("\n");

/** Runs in the page. `seen` remembers when this guest first saw each chat message. Self-contained, because Playwright serializes it. */
async function browserSample() {
  const snapshot = window.proofClient.getSnapshot();
  window.deployHoldSeen ??= new Map();
  for (const message of snapshot.chat.messages) if (!window.deployHoldSeen.has(message.text)) window.deployHoldSeen.set(message.text, Date.now());
  let outAudio = 0;
  const received = new Map();
  for (const connection of window.proofConnections) {
    if (connection.connectionState === "closed") continue;
    const rows = await connection.getStats().catch(() => new Map());
    for (const row of rows.values()) {
      if (row.type === "outbound-rtp" && row.kind === "audio") outAudio += row.bytesSent;
      if (row.type === "inbound-rtp") received.set(row.trackIdentifier, row.bytesReceived);
    }
  }
  return { reachable: true, status: snapshot.connection.status, participantId: snapshot.self.participantId, outAudio, remotes: [...received.values()].map((bytes) => ({ bytes })) };
}

const unreachable = { reachable: false, status: "unreachable", participantId: null, outAudio: 0, remotes: [] };
const sample = (page) => Promise.race([page.evaluate(browserSample), new Promise((resolve) => setTimeout(() => resolve(unreachable), 5000))]).catch(() => unreachable);

function runDeploy() {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { stdio: "inherit" });
    child.on("exit", (code) => resolve({ startedAt, endedAt: Date.now(), code }));
  });
}

export async function deployHoldProof(run, receiver) {
  check(command, "DEPLOY_HOLD_COMMAND is required", "configuration");
  const space = await createSpace(run, mediaPlane);
  const { episode, end } = await createEpisode(run, space);
  run.episodeId = episode.id;
  console.log(`Joining ${guestCount} synthetic camera/voice guests on ${mediaPlane}`);
  const guests = await launchGuests(run, space, episode, "", receiver.origin, true, guestCount);
  const ticks = [];
  const sent = [];
  let deploy = null;
  const startedAt = Date.now();
  let deploying = null;
  let number = 0;
  while (!deploy || Date.now() - deploy.endedAt < afterMs) {
    const t = Date.now();
    if (!deploying && t - startedAt >= beforeMs) {
      console.log("Running the deploy command under the live call");
      deploying = runDeploy().then((result) => (deploy = result));
    }
    const text = `hold-${number++}`;
    const sentAt = Date.now();
    guests.pages[0]
      .evaluate(
        (value) =>
          window.proofClient.chat.send({ text: value }).then(
            () => "ok",
            (error) => String(error?.message ?? error),
          ),
        text,
      )
      .then(
        (outcome) => sent.push({ text, sentAt, ok: outcome === "ok", ...(outcome === "ok" ? {} : { outcome }) }),
        (error) => sent.push({ text, sentAt, ok: false, outcome: String(error.message).split("\n")[0] }),
      );
    ticks.push({ t, guests: await Promise.all(guests.pages.map(sample)) });
    await run.wait(Math.max(0, intervalMs - (Date.now() - t)));
  }
  await deploying;
  await run.wait(2000);
  const delivered = [];
  for (const page of guests.pages.slice(1)) delivered.push(new Map(await page.evaluate(() => [...(window.deployHoldSeen ?? new Map())]).catch(() => [])));
  const judged = judgeDeployHold({ ticks, sent: sent.sort((a, b) => a.sentAt - b.sentAt), delivered, deploy, intervalMs });
  const failures = [...judged.failures];
  if (deploy.code !== 0) failures.push(`the deploy command exited ${deploy.code}`);
  console.log(`Deploy hold evidence: ${JSON.stringify(judged.evidence)}`);
  for (const failure of failures) console.log(`Deploy hold failure: ${failure}`);
  await save(`${run.directory}/deploy-hold.json`, { evidence: judged.evidence, failures, sent, ticks });
  await end();
  for (const page of guests.pages) await page.context().close();
  check(!failures.length, failures.join("; "));
  return judged.evidence;
}
