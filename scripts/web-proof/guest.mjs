import { readFile } from "node:fs/promises";
import { createRun } from "../prod-proof/runtime.mjs";
import { launchGuests, stats } from "../prod-proof/media.mjs";
import { save } from "../prod-proof/runtime.mjs";
import { playIncomingAudio } from "./media.mjs";
import { boardDraw, boardElements, boardOpen, boardView } from "./board.mjs";
import { guestConfig } from "./environment.mjs";

/** Joins the web app to the proof Space as "Web proof A" beside one SDK guest, then disposes the guest. */
export async function withProofCall({ app, screen }, run) {
  const invite = process.env.CHALK_E2E_INVITE;
  const directory = process.env.CHALK_E2E_DIRECTORY;
  if (!invite || !directory) throw new Error("Run pnpm web:proof to provision and clean the proof Space");
  const guest = await prepareGuest(directory);
  const errors = [];
  let joined = false;
  const call = async () => {
    await app.open(invite);
    await screen.getByLabel("Your name").fill("Web proof A");
    await screen.getByRole("button", "Join call", { exact: true }).click();
    joined = true;
    await run(guest);
  };
  for (const step of [call, () => leaveWebCall(screen, joined), () => guest.dispose()]) {
    await step().catch((error) => errors.push(error));
  }
  throwErrors(errors, "Web proof call or cleanup failed");
}

function throwErrors(errors, message) {
  const failures = [...new Set(errors.flatMap(flattenErrors))];
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, message);
}

async function leaveWebCall(screen, joined) {
  const leave = screen.getByRole("button", "Leave call", { exact: true });
  if (await leave.count()) await leave.click();
  // The left heading appears during leave; Rejoin stays disabled until release finishes.
  if (joined) await screen.getByRole("button", "Rejoin", { exact: true, disabled: false }).waitFor({ state: "visible", timeout: 15_000 });
}

function flattenErrors(error) {
  return error instanceof AggregateError ? error.errors.flatMap(flattenErrors) : [error];
}

async function prepareGuest(directory) {
  const run = await createRun(guestConfig(process.env), directory, undefined, process.env.CHALK_E2E_RUN_ID);
  run.apiKey = process.env.CHALK_E2E_API_KEY;
  const space = JSON.parse(await readFile(`${directory}/space.json`, "utf8"));
  const episode = JSON.parse(await readFile(`${directory}/episode.json`, "utf8"));
  const ready = launchGuests(run, space, episode, "", run.config.proof_origin, true, 1);
  // The test awaits this promise after opening the app; keep early failure handled.
  ready.catch(() => {});
  let leaving;
  const leave = () =>
    (leaving ??= ready.then(async (guest) => {
      const errors = [];
      await guest.pages[0]
        .evaluate(async () => {
          if (window.proofBoard) await window.proofClient.whiteboard.transport().setPresentation(false);
        })
        .catch((error) => errors.push(error));
      await guest.pages[0].evaluate(() => window.proofClient.leave()).catch((error) => errors.push(error));
      throwErrors(errors, "SDK guest leave failed");
    }));
  return {
    ready,
    async playAudio() {
      const guest = await ready;
      await save(`${directory}/sdk-before-playback.json`, await stats(guest.pages));
      await guest.pages[0].evaluate(playIncomingAudio);
    },
    async evidence(web) {
      const guest = await ready;
      await save(`${directory}/media.json`, { web, sdk: await stats(guest.pages) });
    },
    async media() {
      const guest = await ready;
      const [rows] = await stats(guest.pages);
      const inbound = rows.filter((row) => row.type === "inbound-rtp");
      const video = inbound.filter((row) => row.kind === "video");
      const audio = inbound.filter((row) => row.kind === "audio");
      return { frames: Math.max(0, ...video.map((row) => row.framesDecoded ?? 0)), audioLevel: Math.max(0, ...audio.map((row) => row.audioLevel ?? 0)) };
    },
    async screenshot() {
      const guest = await ready;
      await guest.pages[0].evaluate(() => {
        document.body.style.cssText = "background:#0f172a;color:white;font:24px sans-serif;padding:24px";
        const view = document.createElement("main");
        document.body.append(view);
        const heading = document.createElement("h1");
        heading.textContent = "SDK proof participant — receiving the real web app";
        view.append(heading);
        const snapshot = window.proofClient.getSnapshot();
        for (const entry of snapshot.media.remote.filter((entry) => entry.track.kind === "video")) {
          const video = document.createElement("video");
          video.autoplay = true;
          video.muted = true;
          video.style.cssText = "width:90%;max-width:1000px";
          video.srcObject = new MediaStream([entry.track]);
          view.append(video);
          void video.play();
        }
      });
      await guest.pages[0].waitForFunction(() => [...document.querySelectorAll("video")].some((video) => video.readyState >= 2));
      await guest.pages[0].screenshot({ path: `${directory}/participant-b.png` });
    },
    /** The guest is an owner, so it can open the board and bring everyone to its view. */
    board: {
      open: async () => (await ready).pages[0].evaluate(boardOpen),
      draw: async () => (await ready).pages[0].evaluate(boardDraw),
      elements: async () => (await ready).pages[0].evaluate(boardElements),
      view: async (view) => (await ready).pages[0].evaluate(boardView, view),
    },
    leave,
    async dispose() {
      const guest = await ready.catch(() => undefined);
      const errors = [];
      if (guest) await leave().catch((error) => errors.push(error));
      const results = await Promise.allSettled([...run.resources].reverse().map((resource) => resource.dispose()));
      errors.push(...results.filter((result) => result.status === "rejected").map((result) => result.reason));
      throwErrors(errors, "SDK guest cleanup failed");
    },
  };
}
