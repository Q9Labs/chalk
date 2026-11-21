import assert from "node:assert/strict";
import { runJourney } from "../../../.agents/skills/verify-chalk/scripts/journey.mjs";

const canvasSelector = '[data-part="screen-annotation-layer"]';
const wait = { timeout: 35_000 };
const saveAction = { name: "Save frame to board", exact: true };

await runJourney("screen-annotation-board", async ({ step, person, startCall, joinByLink, control, shot }) => {
  const sharer = await person("Sharer", 1, { display: true, permission: "granted", record: false });
  const drawer = await person("Drawer", 2, { permission: "granted", record: false });
  const observer = await person("Observer", 3, { permission: "granted", record: false });
  const uploadIds = [];
  let droppedFinalize = false;

  await step("A viewer finishes a kept mark on a live shared screen", async () => {
    const call = await startCall(sharer);
    await Promise.all([joinByLink(drawer, call.link), joinByLink(observer, call.link)]);
    await control(sharer, "Share screen");
    await drawer.page.getByRole("button", { name: "Annotate", exact: true }).click(wait);
    await drawer.page.getByRole("button", { name: "Keep new marks", exact: true }).click();
    const bounds = await drawer.page.locator(canvasSelector).first().boundingBox(wait);
    assert.ok(bounds, "viewer has an annotation canvas");
    const { x, y, width, height } = bounds;
    await drawer.page.mouse.move(x + width * 0.42, y + height * 0.39);
    await drawer.page.mouse.down();
    await drawer.page.mouse.move(x + width * 0.65, y + height * 0.53, { steps: 12 });
    await drawer.page.mouse.up();
    await drawer.page.mouse.move(8, 8);
    await drawer.page.getByRole("button", { name: "Undo mark", exact: true }).waitFor(wait);
  });

  await step("Retry after a lost finalize response reuses the exact board file ID", async () => {
    await drawer.page.route("**/v1/whiteboard/scenes/*/files/*/upload", async (route) => {
      uploadIds.push(new URL(route.request().url()).pathname.split("/").at(-2));
      await route.continue();
    });
    await drawer.page.route("**/v1/whiteboard/scenes/*/files/*/finalize", async (route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 204, "the server finalized the file before the response was lost");
      if (!droppedFinalize) {
        droppedFinalize = true;
        await route.abort("connectionreset");
      } else {
        await route.fulfill({ response });
      }
    });
    await drawer.page.getByRole("button", saveAction).click(wait);
    await drawer.page.getByRole("status").filter({ hasText: "The annotated frame could not be saved." }).waitFor(wait);
    await drawer.page.getByRole("button", saveAction).click(wait);
    await drawer.page.getByRole("status").filter({ hasText: "Frame saved to the board." }).waitFor(wait);
    assert.ok(droppedFinalize);
    assert.equal(uploadIds.length, 2);
    assert.equal(uploadIds[0], uploadIds[1]);
  });

  await step("A second participant receives the original frame and one editable mark", async () => {
    await sharer.page.getByRole("region", { name: "Space stage", exact: true }).hover();
    await sharer.page.getByLabel("Stop sharing", { exact: true }).click();
    const downloaded = observer.page.waitForResponse((response) => response.ok() && /^\/v1\/whiteboard\/files\/.+\/download$/.test(new URL(response.url()).pathname), wait);
    await control(observer, "Board");
    await Promise.all([downloaded, observer.page.locator('.chalk-board[data-elements="2"]').waitFor(wait)]);
    await shot(observer, "board-image-and-editable-mark");
  });
});
