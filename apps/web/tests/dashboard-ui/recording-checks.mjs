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
        if (evidence) await tab.screenshot({ path: resolve(evidence, `${scenario}-${width}.png`), fullPage: true });
      } finally {
        await context.close();
      }
    }
  }
  if (process.env.DASHBOARD_RECORDING_BASELINE) return;
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
        check("ready export displays the player without a reload", (await tab.locator("video[src]").count()) === 1);
        await tab.getByRole("button", { name: "Download", exact: true }).click();
        check("ready export offers the actual MP4 download", (await tab.getByRole("menuitem", { name: "Recording (MP4)", exact: true }).count()) === 1);
        if (evidence) await tab.screenshot({ path: resolve(evidence, "playback-1440.png"), fullPage: true });
      }
    } finally {
      await context.close();
    }
  }
}
