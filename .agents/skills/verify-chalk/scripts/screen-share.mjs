#!/usr/bin/env node
// Drives share → stop → share again in real browsers. One sharer and viewers, each in Chromium or WebKit; the viewers must see the
// shared screen as live video, the tile must disappear when the sharer stops, and come back when they share again.
//
//   node .agents/skills/verify-chalk/scripts/screen-share.mjs <run-id> [--web <origin>] [--sharer chromium|webkit] [--viewers webkit,chromium] [--fault [--fault-calls N|all]] [--devices on|off] [--stop-via toolbar|pill]
//
// --fault answers the sharer's SFU "tracks_close" signals during the first stop with HTTP 404 without forwarding them (the first one by
// default, every one with --fault-calls all), as when the SFU session is already gone. The stop must still succeed. Chromium's sharer captures its fake screen. Headless WebKit cannot answer
// its display-capture prompt, so a WebKit sharer's getDisplayMedia returns an animated canvas stream (the log says so); everything after the capture is the real product path.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runJourney } from "./journey.mjs";

const option = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const sharerEngine = option("--sharer", "chromium");
const viewerEngines = option("--viewers", "webkit").split(",");
const fault = process.argv.includes("--fault");
const devices = option("--devices", "on"); // "on": the sharer's microphone and camera are on while sharing, as in a class; "off": the share is the only published media
const faultCalls = option("--fault-calls", "1") === "all" ? Number.POSITIVE_INFINITY : Number(option("--fault-calls", "1")); // how many close calls --fault answers with 404: 1, or "all" for a media session that is gone for good
const stopVia = option("--stop-via", "toolbar"); // the toolbar toggle, or the "Stop sharing" pill on the stage
const waitMs = 60_000;
const stopMs = 20_000;

// Runs in the page: the shared screen's tile as this page shows it.
const shareTile = (name) => {
  const tile = document.querySelector(`[aria-label="Screen share tile for ${name}"]`)?.closest('[data-part="stage-tile"]');
  const video = tile?.querySelector("video");
  return {
    tile: Boolean(tile),
    width: video?.videoWidth ?? 0,
    height: video?.videoHeight ?? 0,
    currentTime: video?.currentTime ?? 0,
    paused: video?.paused ?? null,
    frames: video?.getVideoPlaybackQuality?.().totalVideoFrames ?? 0,
  };
};

// Runs in the page: text a person would read as a failure.
const visibleProblems = () => [...document.querySelectorAll('[role="alert"], [role="status"], [data-sonner-toast], [data-part*="toast"]')].map((node) => node.textContent?.trim()).filter(Boolean);

const syntheticDisplay = () => {
  // Headless WebKit exposes getDisplayMedia but never answers its permission prompt, so the call hangs.
  window.__syntheticDisplay = true;
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 1280, height: 720 });
    const paint = canvas.getContext("2d");
    let tick = 0;
    setInterval(() => {
      tick += 1;
      paint.fillStyle = `hsl(${(tick * 5) % 360} 70% 40%)`;
      paint.fillRect(0, 0, 1280, 720);
      paint.fillStyle = "#fff";
      paint.font = "64px sans-serif";
      paint.fillText(`synthetic screen ${tick}`, 80, 360);
    }, 100);
    return canvas.captureStream(15);
  };
};

await runJourney(`screen-share-${sharerEngine}${fault ? "-fault" : ""}`, async ({ step, person, startCall, joinByLink, control, shot, out }) => {
  const log = [];
  const note = (message, extra = {}) => log.push({ at: new Date().toISOString(), message, ...extra });
  const sharer = await person("Sharer", 1, { engine: sharerEngine, display: true, permission: "granted" });
  const viewers = [];
  for (const [index, engine] of viewerEngines.entries()) viewers.push({ engine, ...(await person(`Viewer${index + 1}${engine}`, index + 2, { engine, permission: "granted" })) });
  const everyone = [sharer, ...viewers];
  const signals = { tracksClose: 0, answered404: 0, forwarded: 0, armed: false };
  const socketFrames = [];

  if (sharerEngine === "webkit") await sharer.context.addInitScript(syntheticDisplay);
  if (fault)
    await sharer.context.route("**/signal", async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || request.postDataJSON()?.op !== "tracks_close" || request.postDataJSON()?.receive_only) return route.continue();
      signals.tracksClose += 1;
      const closing = JSON.stringify(request.postDataJSON()?.close_tracks ?? [])
        .replace(/"(trackName|publication_id)":"[^"]*"/g, "")
        .slice(0, 200);
      if (fault && signals.armed && signals.answered404 < faultCalls) {
        signals.answered404 += 1;
        note("intercepted tracks_close #" + signals.tracksClose + ": answered 404 without forwarding", { closing });
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "media.connection_not_found" }) });
      }
      signals.forwarded += 1;
      note("tracks_close #" + signals.tracksClose + " forwarded to the API", { closing });
      return route.continue();
    });
  // Every SFU signalling call the sharer makes, in order, with the API's answer.
  signals.ops = [];
  sharer.page.on("response", (response) => {
    if (!response.url().endsWith("/signal")) return;
    signals.ops.push({ at: new Date().toISOString().slice(11, 23), op: response.request().postDataJSON()?.op, status: response.status() });
  });
  sharer.page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      const text = String(payload);
      if (socketFrames.length < 60 && /retry_exhausted|retryable_failure|screen/i.test(text)) socketFrames.push({ at: new Date().toISOString(), frame: text.slice(0, 400) });
    }),
  );

  // While sharing, the stage also shows a "Stop sharing" pill; the toolbar toggle is the one with the aria-label.
  const toolbarStop = sharer.page.getByLabel("Stop sharing", { exact: true });
  const stagePill = sharer.page.getByTestId("stage").getByRole("button", { name: "Stop sharing", exact: true });
  const screenLabel = "Screen share tile for Sharer";
  const state = async (who) => who.page.evaluate(shareTile, "Sharer");
  const hasLiveShare = async (who) => {
    await who.page.getByLabel(screenLabel, { exact: true }).first().waitFor({ timeout: waitMs });
    const deadline = Date.now() + waitMs;
    let first = await state(who);
    while (first.width === 0 && Date.now() < deadline) {
      await who.page.waitForTimeout(500);
      first = await state(who);
    }
    if (first.width === 0) throw new Error(`${who.name} has the tile but no decoded video (${JSON.stringify(first)})`);
    await who.page.waitForTimeout(3000);
    const second = await state(who);
    if (!(second.currentTime > first.currentTime && second.frames > first.frames)) throw new Error(`${who.name}'s share tile is not advancing: ${JSON.stringify({ first, second })}`);
    return { width: second.width, height: second.height, framesGained: second.frames - first.frames, secondsAdvanced: Number((second.currentTime - first.currentTime).toFixed(2)) };
  };
  const shareGone = async (who) => who.page.getByLabel(screenLabel, { exact: true }).waitFor({ state: "detached", timeout: stopMs });

  const startShare = async () => {
    note("Sharer presses Share screen");
    await control(sharer, "Share screen");
    await sharer.page.getByRole("region", { name: "Space stage", exact: true }).hover();
    await toolbarStop.waitFor({ timeout: 30_000 });
    note("Sharer shows Stop sharing");
  };
  const everyoneSeesShare = async (label) => {
    const seen = {};
    for (const who of everyone) {
      seen[who.name] = await hasLiveShare(who);
      note(`${who.name} sees the share live`, seen[who.name]);
    }
    for (const who of everyone) await shot(who, label);
    return seen;
  };
  const stopShare = async (label) => {
    const started = Date.now();
    note("Sharer presses Stop sharing");
    await sharer.page.getByRole("region", { name: "Space stage", exact: true }).hover();
    await (stopVia === "pill" ? stagePill : toolbarStop).click();
    const stopped = sharer.page.getByLabel("Share screen", { exact: true });
    try {
      await stopped.waitFor({ timeout: stopMs });
    } catch (error) {
      const problems = await sharer.page.evaluate(visibleProblems);
      note("Stop did not complete", { problems, socketFrames });
      await shot(sharer, `${label}-stop-failed`);
      throw new Error(`stop did not complete in ${stopMs} ms; visible: ${JSON.stringify(problems)}; sync frames: ${JSON.stringify(socketFrames.slice(-3))}`);
    }
    note("Sharer shows Share screen", { afterMs: Date.now() - started });
    for (const who of everyone) {
      await shareGone(who).catch(async (error) => {
        const statuses = await sharer.page.evaluate(visibleProblems);
        note(`${who.name} still shows the share tile after stop`, { statuses, tracksClose: signals.tracksClose, socketFrames });
        await shot(sharer, `${label}-stop-failed`);
        throw new Error(`${who.name} still shows the share tile ${stopMs} ms after stop; sharer statuses ${JSON.stringify(statuses)}; sync frames ${JSON.stringify(socketFrames.slice(-3))}; ${error.message.split("\n")[0]}`);
      });
    }
    note("the share tile is gone for the sharer and every viewer", { afterMs: Date.now() - started });
    await sharer.page.waitForTimeout(3000); // a failed stop is retried by Sync and reported within about a second
    const statuses = await sharer.page.evaluate(visibleProblems);
    note("sharer statuses after stop", { statuses, tracksClose: signals.tracksClose, answered404: signals.answered404, toastHtml: await sharer.page.evaluate(() => document.querySelector('[role="alert"], [role="status"]')?.outerHTML.slice(0, 600)) });
    if (socketFrames.some(({ frame }) => /retry_exhausted/.test(frame))) throw new Error(`Sync reported retry_exhausted: ${JSON.stringify(socketFrames.at(-1))}`);
    const problems = statuses.filter((text) => /fail|error|couldn|unable|try again|retry|went wrong/i.test(text));
    if (problems.length) throw new Error(`the sharer sees an error after stop: ${JSON.stringify(problems)}`);
    for (const who of everyone) await shot(who, label);
    return { stopMs: Date.now() - started };
  };

  try {
    await step("the sharer starts a call and the viewers join by its link", async () => {
      const call = await startCall(sharer);
      for (const who of viewers) await joinByLink(who, call.link);
      const capture = await sharer.page.evaluate(() => ({ getDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia, engine: navigator.userAgent }));
      note("sharer capture support", capture);
      return { sharer: sharerEngine, viewers: viewerEngines, capture };
    });
    if (devices === "on") {
      await step("the sharer turns on microphone and camera", async () => {
        await sharer.page.getByRole("region", { name: "Space stage", exact: true }).hover();
        for (const name of ["Unmute microphone", "Turn on camera"]) await sharer.page.getByRole("button", { name, exact: true }).click();
        for (const name of ["Mute microphone", "Turn off camera"]) await sharer.page.getByRole("button", { name, exact: true }).waitFor({ timeout: 15_000 });
        await sharer.page.waitForTimeout(3000);
      });
    }
    await step("the sharer shares their screen and every viewer sees live video", async () => {
      await startShare();
      const seen = await everyoneSeesShare("1-sharing");
      note("synthetic display used", { synthetic: await sharer.page.evaluate(() => Boolean(window.__syntheticDisplay)) });
      return seen;
    });
    await step(fault ? "the sharer stops while the SFU answers 404 to the close call: the stop completes and every viewer's tile goes" : "the sharer stops: no error and every viewer's tile goes", async () => {
      signals.armed = true;
      const result = await stopShare("2-stopped");
      signals.armed = false;
      if (fault && signals.answered404 < 1) throw new Error(`the 404 was never injected (tracks_close seen ${signals.tracksClose} times)`);
      return { ...result, ...signals };
    });
    await step("the sharer shares again and every viewer sees live video", async () => {
      await startShare();
      return everyoneSeesShare("3-resharing");
    });
    await step("the sharer stops the second share cleanly", async () => stopShare("4-stopped-again"));
  } finally {
    await writeFile(join(out, "proof-log.json"), `${JSON.stringify({ sharer: sharerEngine, viewers: viewerEngines, fault, signals, log, socketFrames }, null, 2)}\n`);
  }
});
