import { runJourney } from "../../../.agents/skills/verify-chalk/scripts/journey.mjs";
import { keepMarks } from "./screen-annotation-support.mjs";

const canvasSelector = '[data-part="screen-annotation-layer"]';
const wait = { timeout: 35_000 };

await runJourney("screen-annotation-live", async ({ step, person, startCall, joinByLink, control, shot }) => {
  const sharer = await person("Sharer", 1, { engine: "chromium", display: true, permission: "granted", record: false });
  const drawer = await person("Drawer", 2, { engine: "chromium", permission: "granted", record: false });
  const observer = await person("Observer", 3, { engine: "chromium", permission: "granted", record: false });

  await step("A real shared screen decodes in two viewer browsers", async () => {
    const call = await startCall(sharer);
    await Promise.all([joinByLink(drawer, call.link), joinByLink(observer, call.link)]);
    await control(sharer, "Share screen");
    for (const { page } of [drawer, observer]) {
      await page.waitForFunction(() => [...document.querySelectorAll("video")].some((video) => video.videoWidth > 0 && video.currentTime > 0 && video.closest('[aria-label="Screen share tile for Sharer"]')), undefined, wait);
    }
    await shot(observer, "shared-screen");
  });

  const waitForInk = (page, expected) =>
    page.waitForFunction(
      ({ selector, expected }) => {
        const canvas = document.querySelector(selector);
        if (!canvas?.width || !canvas.height) return false;
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        return data.some((value, index) => index % 4 === 3 && value > 0) === expected;
      },
      { selector: canvasSelector, expected },
      { timeout: 30_000, polling: 150 },
    );

  await step("A viewer's kept mark appears in a second browser", async () => {
    await drawer.page.getByRole("button", { name: "Draw", exact: true }).click(wait);
    await keepMarks(drawer.page);
    const canvas = drawer.page.locator(canvasSelector).first();
    const bounds = await canvas.boundingBox(wait);
    if (!bounds) throw new Error("The drawer has no annotation plane.");
    await drawer.page.mouse.move(bounds.x + bounds.width * 0.41, bounds.y + bounds.height * 0.41);
    await drawer.page.mouse.down();
    await drawer.page.mouse.move(bounds.x + bounds.width * 0.62, bounds.y + bounds.height * 0.58, { steps: 12 });
    await drawer.page.mouse.up();
    await drawer.page.mouse.move(8, 8);
    // Undo must clear the second browser as well, distinguishing a durable mark from pointer presence.
    await waitForInk(observer.page, true);
    await shot(observer, "remote-kept-mark");
    await drawer.page.getByRole("button", { name: "Undo", exact: true }).click();
    await waitForInk(observer.page, false);
    await drawer.page.getByRole("button", { name: "More", exact: true }).click();
    await drawer.page.getByRole("menuitem", { name: "Redo", exact: true }).click();
    await waitForInk(observer.page, true);
  });

  await step("Stopping the share removes its annotation plane", async () => {
    await sharer.page.getByRole("region", { name: "Space stage", exact: true }).hover();
    await sharer.page.getByLabel("Stop sharing", { exact: true }).click();
    await observer.page
      .locator(canvasSelector)
      .first()
      .waitFor({ state: "detached", ...wait });
    await shot(observer, "share-ended");
  });
});
