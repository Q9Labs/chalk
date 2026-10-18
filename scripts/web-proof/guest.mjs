import { readFile } from "node:fs/promises";
import { createRun, loadConfig } from "../prod-proof/runtime.mjs";
import { launchGuests, stats } from "../prod-proof/media.mjs";

export async function prepareGuest(directory) {
  const run = await createRun(await loadConfig(), directory, undefined, process.env.CHALK_E2E_RUN_ID);
  run.apiKey = process.env.CHALK_E2E_API_KEY;
  const space = JSON.parse(await readFile(`${directory}/space.json`, "utf8"));
  const episode = JSON.parse(await readFile(`${directory}/episode.json`, "utf8"));
  const ready = launchGuests(run, space, episode, "", run.config.proof_origin, true, 1);
  // The test awaits this promise after opening the app; keep early failure handled.
  ready.catch(() => {});
  return {
    ready,
    async media() {
      const guest = await ready;
      const [rows] = await stats(guest.pages);
      const video = rows.find((row) => row.type === "inbound-rtp" && row.kind === "video");
      const audio = rows.find((row) => row.type === "inbound-rtp" && row.kind === "audio");
      return { frames: video?.framesDecoded ?? 0, audioLevel: audio?.audioLevel ?? 0 };
    },
    async screenshot() {
      const guest = await ready;
      await guest.pages[0].evaluate(() => {
        document.body.style.cssText = "background:#0f172a;color:white;font:24px sans-serif;padding:24px";
        document.body.replaceChildren();
        const heading = document.createElement("h1");
        heading.textContent = "SDK proof participant — receiving the real web app";
        document.body.append(heading);
        const snapshot = window.proofClient.getSnapshot();
        for (const entry of snapshot.media.remote.filter((entry) => entry.track.kind === "video")) {
          const video = document.createElement("video");
          video.autoplay = true;
          video.muted = true;
          video.style.cssText = "width:90%;max-width:1000px";
          video.srcObject = new MediaStream([entry.track]);
          document.body.append(video);
          void video.play();
        }
      });
      await guest.pages[0].waitForFunction(() => [...document.querySelectorAll("video")].some((video) => video.readyState >= 2));
      await guest.pages[0].screenshot({ path: `${directory}/participant-b.png` });
    },
    async leave() {
      const guest = await ready;
      await guest.pages[0].evaluate(() => window.proofClient.leave());
    },
    async dispose() {
      await ready.catch(() => {});
      const results = await Promise.allSettled([...run.resources].reverse().map((resource) => resource.dispose()));
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "SDK guest cleanup failed");
    },
  };
}
