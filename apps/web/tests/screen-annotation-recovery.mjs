import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runJourney } from "../../../.agents/skills/verify-chalk/scripts/journey.mjs";

const target = "Annotation source selected by Chromium";
const canvas = '[data-part="screen-annotation-layer"]';
const wait = { timeout: 35_000 };

function wire(page) {
  const log = [];
  page.on("websocket", (socket) => {
    for (const direction of ["framesent", "framereceived"]) {
      socket.on(direction, ({ payload }) => {
        if (typeof payload !== "string" || !payload.includes('"annotation_')) return;
        const message = JSON.parse(payload);
        log.push({ direction, message });
      });
    }
  });
  return log;
}

async function until(read, message) {
  const deadline = Date.now() + wait.timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(25);
  }
  throw new Error(message);
}

function recent(log, type, predicate = () => true) {
  return log.findLast(({ message }) => message.type === type && predicate(message))?.message;
}

async function tapInk(page, y) {
  const open = page.getByRole("button", { name: "Draw", exact: true });
  if (await open.isVisible()) await open.click();
  await page.getByRole("button", { name: "More", exact: true }).click();
  const fade = page.getByRole("menuitemcheckbox", { name: "Marks fade" });
  if ((await fade.getAttribute("aria-checked")) === "true") await fade.click();
  await page.keyboard.press("Escape");
  const box = await page.locator(canvas).first().boundingBox(wait);
  assert.ok(box);
  await page.mouse.move(box.x + box.width * 0.38, box.y + box.height * y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.58, box.y + box.height * y, { steps: 8 });
  await page.mouse.up();
  await page.mouse.move(8, 8);
}

function hasFrame({ selector, color }) {
  const frame = document.querySelector(selector);
  if (!frame?.videoWidth || frame.currentTime <= 0) return false;
  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  const context = probe.getContext("2d");
  context.drawImage(frame, 0, 0, 1, 1);
  const data = context.getImageData(0, 0, 1, 1).data;
  return data[color] > 150 && data[(color + 1) % 3] < 80 && data[(color + 2) % 3] < 80;
}

await runJourney("screen-annotation-recovery", async ({ step, person, startCall, joinByLink, control, out }) => {
  const sharer = await person("Sharer", 1, { display: target, permission: "granted", record: false });
  const viewer = await person("Viewer", 2, { permission: "granted", record: false });
  const sent = wire(viewer.page);
  const host = wire(sharer.page);
  const facts = [];
  const tile = '[data-part="share-media"] video';

  for (const { context } of [sharer, viewer]) {
    await context.addInitScript(() => {
      const sockets = [];
      window.WebSocket = class extends WebSocket {
        constructor(...args) {
          super(...args);
          if (new URL(this.url).pathname === "/v1/sync") sockets.push(this);
        }
      };
      window.proofSyncSocket = () => sockets.findLast((socket) => socket.readyState === WebSocket.OPEN);
    });
  }

  const tab = async (title, color) => {
    const source = await sharer.context.newPage();
    await source.goto(`data:text/html,${encodeURIComponent(`<title>${title}</title><body style="background:${color}">`)}`);
    return source;
  };
  const decoded = (color) => viewer.page.waitForFunction(hasFrame, { selector: tile, color }, wait);
  const observationLayer = () => recent(sent, "annotation_state", ({ state }) => state)?.state.layer;
  const kept = async (y) => {
    const before = sent.length;
    await tapInk(viewer.page, y);
    await viewer.page.getByRole("button", { name: "Undo", exact: true }).waitFor(wait);
    const command = recent(sent.slice(before), "annotation_command", (message) => message.command.kind === "commit");
    const accepted = await until(() => recent(sent.slice(before), "annotation_receipt", (message) => message.operation_id === command?.operation_id), "No receipt for the new mark");
    assert.equal(accepted?.result.kind, "accepted");
    return command;
  };

  let red;
  let blue;
  let first;
  let firstCommand;
  let replacement;
  let restarted;
  let lastCommand;

  await step("Share a red tab and keep one mark on its publication", async () => {
    red = await tab(target, "#d00000");
    blue = await tab("Not selected", "#0000d0");
    const call = await startCall(sharer);
    await joinByLink(viewer, call.link);
    await sharer.page.bringToFront();
    await control(sharer, "Share screen");
    await decoded(0);
    await viewer.page.locator(canvas).first().waitFor(wait);
    first = observationLayer();
    firstCommand = await kept(0.43);
  });

  await step("Replace the live share with a second tab and reject an old-layer commit", async () => {
    await red.evaluate(() => {
      document.title = "Previous capture";
    });
    await blue.evaluate((title) => {
      document.title = title;
    }, target);
    await sharer.page.bringToFront();
    await sharer.page.getByRole("group", { name: "Your share" }).getByRole("button", { name: "Change", exact: true }).click();
    await sharer.page.getByRole("menuitem", { name: "Browser tab", exact: true }).click();
    await decoded(2);
    await viewer.page.locator(canvas).first().waitFor(wait);
    replacement = observationLayer();
    assert.notEqual(replacement.publication_id, first.publication_id);
    assert.notEqual(replacement.layer_id, first.layer_id);
    const before = sent.length;
    await viewer.page.evaluate((message) => window.proofSyncSocket().send(JSON.stringify(message)), firstCommand);
    const { result } = await until(() => recent(sent.slice(before), "annotation_receipt", (message) => message.operation_id === firstCommand.operation_id), "No stale command receipt");
    assert.deepEqual(result, { kind: "rejected", reason: "stale_layer" });
    await kept(0.54);
    facts.push({ transition: "replacement", publicationChanged: true, layerChanged: true, staleWrite: result.reason });
  });

  await step("Stop sharing and restart the red tab without its old ink", async () => {
    await sharer.page.getByRole("region", { name: "Space stage", exact: true }).hover();
    await sharer.page.getByLabel("Stop sharing", { exact: true }).click();
    await viewer.page
      .locator(canvas)
      .first()
      .waitFor({ state: "detached", ...wait });
    await blue.evaluate(() => {
      document.title = "Not selected";
    });
    await red.evaluate((title) => {
      document.title = title;
    }, target);
    await control(sharer, "Share screen");
    await decoded(0);
    await viewer.page.locator(canvas).first().waitFor(wait);
    restarted = observationLayer();
    assert.notEqual(restarted.publication_id, replacement.publication_id);
    assert.notEqual(restarted.layer_id, first.layer_id);
    assert.notEqual(restarted.layer_id, replacement.layer_id);
    const marks = recent(sent, "annotation_state", ({ state }) => state?.layer.layer_id === restarted.layer_id).state.marks;
    assert.equal(marks.length, 0);
    lastCommand = await kept(0.47);
    facts.push({ transition: "stop/restart", publicationChanged: true, layerChanged: true, initialMarks: marks.length });
  });

  for (const [name, { page, context }, log] of [
    ["viewer", viewer, sent],
    ["sharer", sharer, host],
  ]) {
    await step(`The ${name}'s Sync connection drops and recovers without duplicating ink`, async () => {
      const before = log.length;
      await context.setOffline(true);
      try {
        await page.evaluate(() => window.proofSyncSocket()?.close(4000, "Test connection drop"));
        await page.waitForFunction(() => !window.proofSyncSocket(), undefined, wait);
        await page
          .locator(canvas)
          .first()
          .waitFor({ state: "detached", ...wait });
      } finally {
        await context.setOffline(false);
      }
      await page.waitForFunction(() => Boolean(window.proofSyncSocket()), undefined, wait);
      const { state } = await until(() => recent(log.slice(before), "annotation_state", ({ state }) => state), "No annotation state after reconnect");
      assert.equal(state.layer.publication_id, restarted.publication_id);
      assert.equal(state.layer.layer_id, restarted.layer_id);
      assert.deepEqual(
        state.marks.map(({ draft }) => draft.mark_id),
        [lastCommand.command.draft.mark_id],
      );
      facts.push({ transition: `${name} Sync recovery`, sameLayer: true, keptMarks: state.marks.length });
    });
  }

  await writeFile(join(out, "authority.json"), JSON.stringify(facts, null, 2));
});
