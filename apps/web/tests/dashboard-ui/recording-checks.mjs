import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function recordingChecks({ open, fixture, check, CALL }) {
  const session = `${CALL}/session/00000000-0000-4000-8000-000000000200`;
  const evidence = process.env.DASHBOARD_RECORDING_EVIDENCE;
  if (evidence) await mkdir(evidence, { recursive: true });
  const reads = async () => (await fixture("log")).filter((entry) => entry.path === "/dashboard-api/call-metadata").length;
  for (const width of [1440, 390]) {
    for (const scenario of ["failed", "expired", "available", "export_failed", "export_exhausted", "transcript_failed"]) {
      const { tab, context } = await open(session, { width, set: `recordingScenario=${scenario}` });
      try {
        const waiting = await tab.locator(".pnote .spin").count();
        const prepare = await tab.getByRole("button", { name: "Prepare recording", exact: true }).count();
        const retry = await tab.getByRole("button", { name: "Try again", exact: true }).count();
        if (scenario === "failed") check(`${width}: terminal capture explains the failure without a spinner`, waiting === 0 && (await tab.getByText("The recording capture did not complete.", { exact: true }).count()) === 1);
        if (scenario === "expired") check(`${width}: expired source stops waiting and offers no unusable action`, waiting === 0 && prepare === 0 && retry === 0 && (await tab.getByText("The recording is no longer available", { exact: true }).count()) === 1);
        if (scenario === "available") {
          check(`${width}: captured source offers preparation before MP4 exists`, waiting === 0 && prepare === 1);
          check(`${width}: canonical complete transcript displays independently of MP4`, (await tab.getByLabel("Search transcript").count()) === 1 && (await tab.locator(".tline").count()) > 0);
        }
        if (scenario === "export_failed") check(`${width}: retryable export offers a retry and keeps its transcript`, retry === 1 && waiting === 0 && (await tab.locator(".tline").count()) > 0);
        if (scenario === "export_exhausted") check(`${width}: exhausted export stops waiting without a retry`, retry === 0 && waiting === 0 && (await tab.getByText("The recording export could not be completed.", { exact: true }).count()) === 1);
        if (scenario === "transcript_failed") check(`${width}: terminal transcript does not spin forever`, (await tab.getByText("The transcript couldn’t be made", { exact: true }).count()) === 1);
        if (evidence) {
          await tab.screenshot({ path: resolve(evidence, `${scenario}-${width}.png`), fullPage: true });
          await tab.waitForTimeout(1500);
        }
      } finally {
        await context.close();
      }
    }
  }
  if (process.env.DASHBOARD_RECORDING_BASELINE) return;
  {
    const { tab, context } = await open(session, { set: "recordingScenario=export_ready" });
    const newerId = "00000000-0000-4000-8000-000000000801";
    const transcriptId = "00000000-0000-4000-8000-000000000901";
    let finished = false;
    const newerTranscript = () => ({ id: transcriptId, status: finished ? "complete" : "transcribing", languages: ["en"], createdAt: new Date().toISOString() });
    try {
      // Two attempts at the dashboard boundary: an older playable video and a newer pending transcript.
      await tab.route("**/dashboard-api/past-session**", async (route) => {
        if (route.request().method() === "GET") {
          const response = await route.fetch();
          const data = await response.json();
          const older = data.recordings[0];
          const newer = { ...older, id: newerId, status: "pending", exportStatus: "none", createdAt: new Date().toISOString(), transcripts: [newerTranscript()] };
          return route.fulfill({ response, json: { ...data, recordings: [newer, older] } });
        }
        const action = route.request().postDataJSON();
        if (action.action === "transcripts" && action.recordingId === newerId) return route.fulfill({ json: { transcripts: [newerTranscript()], nextCursor: null } });
        if (action.action === "transcript-document" && action.transcriptId === transcriptId) return route.fulfill({ json: { cues: [{ startMs: 0, endMs: 1000, text: "Newer finished transcript", speaker: null }] } });
        return route.continue();
      });
      await tab.reload({ waitUntil: "networkidle" });
      await tab.getByRole("button", { name: "Play", exact: true }).click();
      await tab.waitForFunction(() => document.querySelector("video")?.currentTime > 1);
      const player = await tab.locator("video").elementHandle();
      const before = await player.evaluate((video) => video.currentTime);
      const urlsBefore = (await fixture("log")).filter((entry) => entry.body?.action === "recording-url").length;
      if (evidence) await tab.screenshot({ path: resolve(evidence, "transcript-switch-before.png"), fullPage: true });
      finished = true;
      await tab.getByText("Newer finished transcript", { exact: true }).waitFor({ timeout: 15_000 });
      const kept = await player.evaluate((video, at) => video.isConnected && video === document.querySelector("video") && !video.paused && video.currentTime > at, before);
      const urlsAfter = (await fixture("log")).filter((entry) => entry.body?.action === "recording-url").length;
      check("a newer finished transcript preserves the older video's playback and URL", kept && urlsAfter === urlsBefore);
      if (evidence) await tab.screenshot({ path: resolve(evidence, "transcript-switch-after.png"), fullPage: true });
    } finally {
      await context.close();
    }
  }
  // The page's clock runs an hour behind the server's, so it must move the server's deadline onto its own clock.
  {
    const { tab, context } = await open(session, { set: "recordingScenario=available&expireIn=8", clock: -3_600_000 });
    try {
      const prepare = tab.getByRole("button", { name: "Prepare recording", exact: true });
      const offered = await prepare.count();
      await tab.waitForTimeout(9000);
      // The deadline's wake and the read's tick are separate timers, so the page renders between the two runs.
      await tab.clock.runFor(8000);
      await tab.waitForTimeout(200);
      await tab.clock.runFor(8000);
      await tab
        .getByText("The recording is no longer available", { exact: true })
        .waitFor({ timeout: 5000 })
        .catch(() => {});
      check("a page an hour behind the server closes Prepare at the server's deadline", offered === 1 && (await prepare.count()) === 0 && (await reads()) === 1, `offered=${offered} reads=${await reads()}`);
    } finally {
      await context.close();
    }
  }
  {
    const { tab, context } = await open(session, { set: "recordingScenario=pending", clock: true });
    try {
      await fixture("set?recordingScenario=missing");
      const request = tab.waitForResponse((response) => response.url().includes("/dashboard-api/call-metadata"));
      await tab.clock.runFor(5000);
      await request;
      // A refused read is final for that recording, which shows the server's error; the rest of the session stays.
      await tab.getByText("Couldn’t load this recording", { exact: true }).waitFor();
      check("a deleted recording leaves session attendance visible", (await tab.getByText("Who came", { exact: true }).count()) === 1 && (await tab.getByText("Couldn’t load this session", { exact: true }).count()) === 0);
      await tab.getByText("Couldn’t load the transcript", { exact: true }).waitFor();
      check("a deleted recording keeps its transcript unavailable", (await tab.getByText("The transcript couldn’t be made", { exact: true }).count()) === 0);
      await tab.clock.runFor(30000);
      check("a deleted recording is not read again", (await reads()) === 1);
      if (evidence) await tab.screenshot({ path: resolve(evidence, "deleted-1440.png"), fullPage: true });
    } finally {
      await context.close();
    }
  }
  // Poll the real page through pending -> terminal, and prove it stops reading afterwards.
  {
    const { tab, context } = await open(session, { set: "recordingScenario=pending", clock: true });
    try {
      check("active capture remains processing while export is temporarily unavailable", (await tab.getByText("Processing the recording", { exact: true }).count()) === 1);
      await fixture("set?recordingScenario=failed");
      const request = tab.waitForResponse((response) => response.url().includes("/dashboard-api/call-metadata"));
      await tab.clock.runFor(5000);
      await request;
      await tab.waitForLoadState("networkidle");
      const stopped = await reads();
      check("capture failure replaces processing without a reload", (await tab.getByText("The recording capture did not complete.", { exact: true }).count()) === 1);
      await tab.clock.runFor(15000);
      check("terminal capture stops metadata polling", (await reads()) === stopped);
    } finally {
      await context.close();
    }
  }
  // Explicit preparation is one request; pending export becomes a working player without a reload.
  {
    const { tab, context } = await open(session, { set: "recordingScenario=available", clock: true });
    try {
      const button = tab.getByRole("button", { name: "Prepare recording", exact: true });
      if ((await button.count()) === 0) {
        check("prepare recording requests an export and reaches playback", false, "no preparation action");
      } else {
        await button.click();
        await tab.getByText("Preparing the recording", { exact: true }).waitFor();
        const exports = (await fixture("log")).filter((entry) => entry.method === "POST" && entry.body?.action === "export-recording");
        check("one explicit action requests one MP4 export", exports.length === 1);
        await fixture("set?recordingScenario=export_ready");
        const request = tab.waitForResponse((response) => response.url().includes("/dashboard-api/call-metadata"));
        await tab.clock.runFor(5000);
        await request;
        await tab.getByRole("region", { name: "Recording", exact: true }).waitFor();
        await tab.clock.resume();
        await tab.locator("video[src]").waitFor({ state: "attached" });
        await tab.waitForFunction(() => {
          const video = document.querySelector("video");
          return video && video.readyState >= 1 && video.duration > 0;
        });
        await tab.getByRole("button", { name: "Play", exact: true }).click();
        await tab.waitForFunction(() => document.querySelector("video")?.currentTime > 0);
        check("ready export plays the prepared MP4 without a reload", await tab.locator("video").evaluate((video) => !video.paused && video.currentTime > 0));
        await tab.getByRole("button", { name: "Pause", exact: true }).click();
        await tab.getByRole("button", { name: "Download", exact: true }).click();
        check("ready export offers the actual MP4 download", (await tab.getByRole("menuitem", { name: "Recording (MP4)", exact: true }).count()) === 1);
        if (evidence) await tab.screenshot({ path: resolve(evidence, "playback-1440.png"), fullPage: true });
      }
    } finally {
      await context.close();
    }
  }
}
