import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createMediaSmokeInitScript } from "./media-smoke-page.mjs";
import { MediaProofError, UNSUPPORTED_ASSERTIONS, aggregateRtcStats, assertPositiveRtcDeltas, deltaRtcStats, isRecord, unsupported, waitFor } from "./media-smoke-core.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const requireFromClient = createRequire(join(repositoryRoot, "sdks/typescript/client/package.json"));

function browserModule(options) {
  if (options.browserType) return options.browserType;
  if (options.playwright?.chromium) return options.playwright.chromium;
  return requireFromClient("playwright").chromium;
}

export async function createParticipantContext(browser, options) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"], ...(options.contextOptions ?? {}) });
  await context.addInitScript({ content: createMediaSmokeInitScript() });
  const page = await context.newPage();
  return { context, page };
}

function joinURL(webURL, joinPath, name, hash = "") {
  const url = new URL(webURL);
  url.pathname = joinPath;
  url.searchParams.set("name", name);
  url.hash = hash;
  return url.toString();
}

async function countLocator(locator) {
  return typeof locator.count === "function" ? locator.count() : 1;
}

export async function joinParticipant(participant, runtime) {
  const { page, name, inviteHash } = participant;
  await page.goto(joinURL(runtime.webURL, runtime.webJoinPath, name, inviteHash), { waitUntil: "domcontentloaded", timeout: runtime.joinTimeoutMs });
  const nameInput = page.getByPlaceholder("Enter your name", { exact: true });
  await requireJoinControl(nameInput, "Enter your name", runtime.joinTimeoutMs);
  await nameInput.fill(name);
  const joinButton = firstLocator(page.getByRole("button", { name: /^Join\b/i }));
  await requireJoinControl(joinButton, "join button", runtime.joinTimeoutMs);
  await joinButton.click();
  const joinedView = firstLocator(page.locator('[data-tour="video-grid"]'));
  try {
    await requireJoinControl(joinedView, "video grid", runtime.joinTimeoutMs);
  } catch (error) {
    if (error?.code !== "unsupported_assertion") throw error;
    const visibleText = typeof page.locator === "function" ? (await page.locator("body").innerText()).replace(/\s+/gu, " ").trim().slice(0, 600) : "";
    unsupported(UNSUPPORTED_ASSERTIONS.joinUI, { control: "video grid", visibleText });
  }
}

async function requireJoinControl(locator, control, timeoutMs) {
  if (typeof locator.waitFor === "function") {
    try {
      await locator.waitFor({ state: "visible", timeout: timeoutMs });
    } catch {
      unsupported(UNSUPPORTED_ASSERTIONS.joinUI, { control });
    }
  }
  if ((await countLocator(locator)) !== 1) unsupported(UNSUPPORTED_ASSERTIONS.joinUI, { control });
}

async function pageState(page, method) {
  return page.evaluate((name) => {
    const tracker = window.__chalkMediaSmoke;
    if (!tracker || typeof tracker[name] !== "function") return undefined;
    return tracker[name]();
  }, method);
}

export async function waitForRemoteTracks(participants, runtime) {
  let missing = "audio";
  try {
    await waitFor(
      "remote audio and video tracks",
      async () => {
        const states = await Promise.all(participants.map((participant) => pageState(participant.page, "tracks")));
        if (states.some((state) => !state || state.hasRtcConnection !== true)) unsupported(UNSUPPORTED_ASSERTIONS.mediaTracker);
        const counts = states.map((state) => ({ audio: state.remote.filter((track) => track.kind === "audio" && track.readyState === "live").length, video: state.remote.filter((track) => track.kind === "video" && track.readyState === "live").length }));
        missing = counts.some((count) => count.audio < 1) ? "audio" : counts.some((count) => count.video < 1) ? "video" : undefined;
        return !missing;
      },
      { timeoutMs: runtime.mediaTimeoutMs, intervalMs: runtime.pollIntervalMs },
    );
  } catch (error) {
    if (error?.code === "timeout") throw new MediaProofError(missing === "audio" ? "remote_audio_not_live" : "remote_video_not_live", `Remote ${missing} track did not become live`, { details: { missing } });
    throw error;
  }
}

async function sampleStats(participant) {
  const state = await pageState(participant.page, "stats");
  if (!Array.isArray(state)) unsupported(UNSUPPORTED_ASSERTIONS.rtcStatsTracker);
  return aggregateRtcStats(state);
}

export async function proveStatsWindow(participants, runtime) {
  const before = await Promise.all(participants.map(sampleStats));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, runtime.statsWindowMs));
  const after = await Promise.all(participants.map(sampleStats));
  const deltas = after.map((summary, index) => deltaRtcStats(before[index], summary));
  deltas.forEach(assertPositiveRtcDeltas);
  return { windowMs: runtime.statsWindowMs, samples: deltas };
}

async function trackerFrames(page) {
  const state = await pageState(page, "tracks");
  if (!state) unsupported(UNSUPPORTED_ASSERTIONS.mediaTracker);
  return state;
}

export async function stopParticipantCamera(primary, guest, runtime) {
  const people = primary.page.getByRole("button", { name: "People", exact: true });
  if ((await countLocator(people)) !== 1) unsupported(UNSUPPORTED_ASSERTIONS.stopParticipantCameraUI, { control: "People" });
  await people.click();
  const panel = firstLocator(primary.page.getByRole("complementary"));
  if ((await countLocator(panel)) !== 1) unsupported(UNSUPPORTED_ASSERTIONS.stopParticipantCameraUI, { control: "participant panel" });
  const options = primary.page.getByRole("button", { name: `Options for ${guest.name}`, exact: true });
  if ((await countLocator(options)) !== 1) unsupported(UNSUPPORTED_ASSERTIONS.stopParticipantCameraUI, { control: `participant options for ${guest.name}` });
  await options.click();
  const stop = primary.page.getByRole("button", { name: "Stop camera", exact: true });
  if ((await countLocator(stop)) !== 1) unsupported(UNSUPPORTED_ASSERTIONS.stopParticipantCameraUI, { control: "Stop camera" });
  const beforePrimaryTracks = await trackerFrames(primary.page);
  const beforeGuestTracks = await trackerFrames(guest.page);
  const beforePrimary = beforePrimaryTracks.frames.length;
  const beforeGuest = beforeGuestTracks.frames.length;
  if (!beforePrimaryTracks.remote.some((track) => track.kind === "video" && track.readyState === "live")) {
    throw new MediaProofError("remote_guest_video_not_live", "Primary participant did not have a live remote guest video track before stopping the camera");
  }
  await stop.click();
  await waitFor(
    "committed stop-participant-camera acknowledgement and event",
    async () => {
      const [primaryState, guestState] = await Promise.all([trackerFrames(primary.page), trackerFrames(guest.page)]);
      const primaryFrames = primaryState.frames.slice(beforePrimary);
      const guestFrames = guestState.frames.slice(beforeGuest);
      const committed = [...primaryFrames, ...guestFrames].some((frame) => frame.type === "ack" && frame.outcome === "committed" && frame.hasEventID);
      const eventObserved = primaryFrames.some((frame) => frame.eventNames.includes("participant_camera_stopped")) && guestFrames.some((frame) => frame.eventNames.includes("participant_camera_stopped"));
      return committed && eventObserved;
    },
    { timeoutMs: runtime.mediaTimeoutMs, intervalMs: runtime.pollIntervalMs },
  );
  await waitFor(
    "remote guest video publication to stop",
    async () => {
      const state = await trackerFrames(primary.page);
      const videos = state.remote.filter((track) => track.kind === "video");
      return videos.length > 0 && videos.every((track) => track.readyState !== "live" || track.muted === true);
    },
    { timeoutMs: runtime.mediaTimeoutMs, intervalMs: runtime.pollIntervalMs },
  );
  return { outcome: "committed", event: "participant_camera_stopped" };
}

export async function queryObservability(runtime, journeyIDs, options) {
  if (typeof options.observabilityProof === "function") {
    const result = await options.observabilityProof({ runtime, journeyIDs });
    if (!isRecord(result)) throw new MediaProofError("observability_invalid_response", "Observability proof contract returned a non-object");
    return result;
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") unsupported(UNSUPPORTED_ASSERTIONS.observabilityProofEndpoint);
  const url = new URL(runtime.observabilityProofURL);
  url.searchParams.set("runtime_id", runtime.runtimeID);
  if (journeyIDs[0]) url.searchParams.set("journey_id", journeyIDs[0]);
  const response = await fetcher(url, { headers: journeyIDs[0] ? { "x-chalk-journey-id": journeyIDs[0] } : undefined });
  if (!response.ok) throw new MediaProofError("observability_http_failed", `Observability proof returned HTTP ${response.status}`);
  const body = await response.json();
  if (!isRecord(body)) throw new MediaProofError("observability_invalid_response", "Observability proof returned a non-object");
  const contract = runtime.observabilityContract;
  if (typeof contract === "function") {
    const contractResult = await contract(body);
    if (contractResult !== true) throw new MediaProofError("observability_contract_failed", typeof contractResult === "string" ? contractResult : "Observability proof contract failed");
  } else if (isRecord(contract)) {
    for (const [key, expected] of Object.entries(contract)) if (body[key] !== expected) throw new MediaProofError("observability_contract_failed", `Observability proof field ${key} did not match contract`);
  }
  return body;
}

export async function leaveParticipant(participant) {
  if (!participant?.page) return;
  await closeParticipantsPanel(participant.page);
  const leave = firstLocator(participant.page.getByRole("button", { name: /^Leave\b/i }));
  if ((await countLocator(leave)) !== 1) throw new MediaProofError("cleanup_leave_ui_missing", "Leave control was unavailable", { phase: "cleanup" });
  await leave.click();
}

async function closeParticipantsPanel(page) {
  const panel = firstLocator(page.getByRole("complementary"));
  if (!(await isLocatorVisible(panel))) return;

  const close = panel.getByRole("button", { name: /^Close\b/i });
  if ((await countLocator(close)) === 1) {
    await close.click();
    await waitFor("participant panel to close", () => isLocatorVisible(panel).then((visible) => !visible), { timeoutMs: 5_000, intervalMs: 50 });
    return;
  }

  if (typeof page.keyboard?.press !== "function") throw new MediaProofError("cleanup_participants_panel_close_unavailable", "Participant panel was open but had no close control", { phase: "cleanup" });
  await page.keyboard.press("Escape");
  try {
    await waitFor("participant panel to close", () => isLocatorVisible(panel).then((visible) => !visible), { timeoutMs: 5_000, intervalMs: 50 });
  } catch {
    throw new MediaProofError("cleanup_participants_panel_close_failed", "Escape did not close the participant panel", { phase: "cleanup" });
  }
}

async function isLocatorVisible(locator) {
  if (typeof locator.isVisible === "function") return locator.isVisible();
  return (await countLocator(locator)) > 0;
}

function firstLocator(locator) {
  return typeof locator.first === "function" ? locator.first() : locator;
}

export async function launchBrowser(options) {
  const browserType = browserModule(options);
  const launchOptions = {
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    ...(process.env.CHALK_E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHALK_E2E_CHROMIUM_EXECUTABLE } : {}),
    ...(options.launchOptions ?? {}),
  };
  try {
    return await browserType.launch(launchOptions);
  } catch (error) {
    if (launchOptions.executablePath || launchOptions.channel || !missingBundledBrowser(error)) throw error;
    return browserType.launch({ ...launchOptions, channel: "chrome" });
  }
}

function missingBundledBrowser(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /executable\s+doesn't\s+exist|executable\s+does\s+not\s+exist|please\s+run.*playwright.*install|browser\s+executable/i.test(message);
}

export async function readTrackerJourneyIDs(participants) {
  const states = await Promise.all(participants.map((participant) => trackerFrames(participant.page)));
  return [...new Set(states.flatMap((state) => state.journeyIds))];
}
