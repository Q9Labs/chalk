import assert from "node:assert/strict";
import { join } from "node:path";
import { runJourney } from "../../../.agents/skills/verify-chalk/scripts/journey.mjs";

const sourceTitle = "Chalk annotation capture source";
const canvas = '[data-part="screen-annotation-layer"]';
const wait = { timeout: 35_000 };

await runJourney("screen-annotation-sharer", async ({ step, person, startCall, joinByLink, control, shot, out }) => {
  const sharer = await person("Sharer", 1, { display: sourceTitle, permission: "granted", record: false });
  const viewer = await person("Viewer", 2, { permission: "granted", record: false });
  const source = await sharer.page.context().newPage();

  await step("The sharer opens a live preview of a separate captured tab", async () => {
    await source.goto(`data:text/html,${encodeURIComponent(`<title>${sourceTitle}</title><body style="background: #eceef2"><h1>Watch this spot</h1></body>`)}`);
    const call = await startCall(sharer);
    await joinByLink(viewer, call.link);
    await sharer.page.bringToFront();
    await control(sharer, "Share screen");
    await sharer.page.getByRole("button", { name: "Pop out marks", exact: true }).click(wait);
    await sharer.page.waitForFunction(
      () => {
        const video = window.documentPictureInPicture?.window?.document.querySelector("video");
        if (!video?.videoWidth || video.currentTime <= 0) return false;
        const frame = document.createElement("canvas");
        frame.width = frame.height = 1;
        const ctx = frame.getContext("2d");
        ctx.drawImage(video, 0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return r > 200 && g > 200 && b > 200;
      },
      undefined,
      wait,
    );
    await viewer.page.locator(canvas).first().waitFor(wait);
  });

  const inPreview = (ink) =>
    sharer.page.waitForFunction(
      ({ selector, ink }) => {
        const preview = window.documentPictureInPicture?.window?.document.querySelector(selector);
        if (!preview?.width || !preview.height) return false;
        return (
          preview
            .getContext("2d")
            .getImageData(0, 0, preview.width, preview.height)
            .data.some((value, index) => index % 4 === 3 && value > 0) === ink
        );
      },
      { selector: canvas, ink },
      wait,
    );

  await step("A remote gesture sets the sharer tab cue and puts its kept mark in PiP", async () => {
    const title = await sharer.page.title();
    await viewer.page.getByRole("button", { name: "Draw", exact: true }).click(wait);
    await viewer.page.getByRole("button", { name: "More", exact: true }).click();
    const fade = viewer.page.getByRole("menuitemcheckbox", { name: "Marks fade" });
    if ((await fade.getAttribute("aria-checked")) === "true") await fade.click();
    await viewer.page.keyboard.press("Escape");
    const bounds = await viewer.page.locator(canvas).first().boundingBox(wait);
    assert.ok(bounds, "viewer has an annotation canvas");
    const { x, y, width, height } = bounds;
    await viewer.page.mouse.move(x + width * 0.43, y + height * 0.43);
    await viewer.page.mouse.down();
    await viewer.page.mouse.move(x + width * 0.58, y + height * 0.55, { steps: 12 });
    await sharer.page.waitForFunction(() => document.title.includes("Viewer is drawing") && !!document.querySelector('link[rel="icon"][href^="data:image/svg+xml,"]'), undefined, wait);
    await viewer.page.mouse.up();
    await viewer.page.mouse.move(8, 8);
    await inPreview(true);
    await sharer.page.waitForFunction((title) => document.title === title, title, wait);
    await inPreview(true);
    const preview = sharer.page
      .context()
      .pages()
      .find((page) => page !== source && page !== sharer.page);
    if (preview) await preview.screenshot({ path: join(out, "screenshots", "sharer-live-pip.png") });
    await shot(sharer, "sharer-tab-marks");
  });

  await step("The sharer pauses and clears marks, then closing the share closes PiP", async () => {
    const who = sharer.page.getByRole("button", { name: /^Who can draw/ });
    await who.click();
    await sharer.page.getByRole("menuitemcheckbox", { name: "Pause drawing" }).click();
    await sharer.page.keyboard.press("Escape");
    await viewer.page.getByRole("status").filter({ hasText: "Marks are paused" }).waitFor(wait);
    await who.click();
    await sharer.page.getByRole("menuitemcheckbox", { name: "Pause drawing" }).click();
    await sharer.page.keyboard.press("Escape");
    await who.click();
    await sharer.page.getByRole("menuitem", { name: "Clear all marks" }).click();
    await inPreview(false);
    await sharer.page.getByRole("region", { name: "Space stage", exact: true }).hover();
    await sharer.page.getByLabel("Stop sharing", { exact: true }).click();
    await sharer.page.waitForFunction(() => !window.documentPictureInPicture?.window, undefined, wait);
  });
});
