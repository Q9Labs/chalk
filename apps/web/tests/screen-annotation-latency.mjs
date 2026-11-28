import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runJourney } from "../../../.agents/skills/verify-chalk/scripts/journey.mjs";
import { keepMarks } from "./screen-annotation-support.mjs";

const canvas = '[data-part="screen-annotation-layer"]';
const sourceTitle = "Annotation latency source";
const timeout = { timeout: 35_000 };
const attempts = 200;
const synthetic = process.argv.includes("--synthetic");

function observeWire(page, direction) {
  const frames = [];
  page.on("websocket", (socket) => {
    socket.on(direction, ({ payload }) => {
      if (typeof payload !== "string" || !payload.includes('"annotation_')) return;
      const frame = JSON.parse(payload);
      const draft = frame.draft ?? frame.command?.draft ?? frame.change?.mark?.draft;
      if (draft) frames.push({ type: frame.type, mark: draft.mark_id, at: performance.now() });
    });
  });
  return frames;
}

async function calibrate(page) {
  const reads = [];
  for (let i = 0; i < 12; i++) {
    const before = performance.now();
    const browser = await page.evaluate(() => performance.now());
    const after = performance.now();
    reads.push({ offset: browser - (before + after) / 2, error: (after - before) / 2 });
  }
  return reads.sort((a, b) => a.error - b.error)[0];
}

function contentBox(selector) {
  const doc = typeof selector === "string" ? document : window.documentPictureInPicture?.window?.document;
  const layer = doc?.querySelector(typeof selector === "string" ? selector : selector.pip);
  if (!layer) return null;
  const rect = layer.getBoundingClientRect();
  const video = (layer.closest('[data-part="share-media"]') ?? layer.parentElement).querySelector("video");
  if (!rect.width || !rect.height || !video?.videoWidth) return null;
  const fit = doc.defaultView.getComputedStyle(video).objectFit;
  const scale = (fit === "cover" ? Math.max : Math.min)(layer.clientWidth / video.videoWidth, layer.clientHeight / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  return { x: rect.left + (rect.width - width) / 2, y: rect.top + (rect.height - height) / 2, width, height };
}

function startWatch({ selector, start, end, box }) {
  const win = typeof selector === "string" ? window : window.documentPictureInPicture.window;
  const layer = win.document.querySelector(typeof selector === "string" ? selector : selector.pip);
  const context = layer.getContext("2d");
  const rect = layer.getBoundingClientRect();
  const region = (point) => {
    const x = ((box.x + point.x * box.width - rect.left) * layer.width) / rect.width;
    const y = ((box.y + point.y * box.height - rect.top) * layer.height) / rect.height;
    return [Math.round(x) - 3, Math.round(y) - 3, 7, 7];
  };
  const startBox = region(start);
  const endBox = region(end);
  const hasInk = (box) => context.getImageData(...box).data.some((red, i, data) => i % 4 === 0 && red > data[i + 1] + 55 && data[i + 2] > data[i + 1] + 55 && data[i + 3] > 80);
  const result = { preview: null, commit: null, occupied: hasInk(startBox) || hasInk(endBox) };
  window.annotationPaint = result;
  const deadline = performance.now() + 1800;
  let preview = false;
  let commit = false;
  const frame = () => {
    if (window.annotationPaint !== result) return;
    // Read pixels, then count the next frame boundary: a paint submitted during
    // a frame callback is not presented until after that callback has returned.
    const now = performance.now();
    if (preview && result.preview === null) result.preview = now;
    if (commit && result.commit === null) result.commit = now;
    const endVisible = hasInk(endBox);
    preview ||= !endVisible && hasInk(startBox);
    commit ||= endVisible;
    if (now < deadline && result.commit === null) win.requestAnimationFrame(frame);
  };
  win.requestAnimationFrame(frame);
}

function placement(box, point) {
  return { x: box.x + box.width * point.x, y: box.y + box.height * point.y };
}

await runJourney("screen-annotation-latency", async ({ step, person, startCall, joinByLink, control, out }) => {
  const sharer = await person("Sharer", 1, { display: synthetic || sourceTitle, permission: "granted", record: false });
  const drawer = await person("Drawer", 2, { permission: "granted", record: false });
  const observer = await person("Observer", 3, { permission: "granted", record: false });
  const sent = observeWire(drawer.page, "framesent");
  const surfaces = [
    { page: observer.page, selector: canvas, surface: "remote", wire: observeWire(observer.page, "framereceived"), samples: [] },
    { page: sharer.page, selector: { pip: canvas }, surface: "sharer_overlay", wire: observeWire(sharer.page, "framereceived"), samples: [] },
  ];

  await step("Publish a shared tab and open the sharer's PiP", async () => {
    if (!synthetic) {
      const source = await sharer.context.newPage();
      await source.goto(`data:text/html,${encodeURIComponent(`<title>${sourceTitle}</title><body style="background:#ddd"><h1>Shared tab</h1></body>`)}`);
    }
    const call = await startCall(sharer);
    await joinByLink(drawer, call.link);
    await joinByLink(observer, call.link);
    await sharer.page.bringToFront();
    await control(sharer, "Share screen");
    await sharer.page.getByRole("button", { name: "Pop out marks", exact: true }).click(timeout);
    await drawer.page.getByRole("button", { name: "Draw", exact: true }).click(timeout);
    await drawer.page.getByRole("button", { name: "Ink colour and width" }).click();
    await drawer.page.getByLabel("Ink colour", { exact: true }).fill("#ff00ff");
    await drawer.page.keyboard.press("Escape");
    await keepMarks(drawer.page);
    for (const endpoint of [{ page: drawer.page, selector: canvas }, ...surfaces]) {
      await endpoint.page.waitForFunction(contentBox, endpoint.selector, timeout);
    }

    await drawer.page.locator(canvas).evaluate((layer) => {
      for (const type of ["pointerdown", "pointerup", "pointercancel", "lostpointercapture"]) {
        layer.addEventListener(type, (event) => window.annotationInput.push({ type, at: event.timeStamp }));
      }
    });
  });

  await step(`Observe ${attempts} gestures on both real paint surfaces`, async () => {
    const sending = await calibrate(drawer.page);
    for (const endpoint of surfaces) {
      const receiving = await calibrate(endpoint.page);
      endpoint.clock = {
        domain: "synchronized_monotonic_clocks",
        receiverMinusSenderMs: receiving.offset - sending.offset,
        uncertaintyMs: receiving.error + sending.error + 1,
      };
      endpoint.frameRate = await endpoint.page.evaluate(async (selector) => {
        const win = typeof selector === "string" ? window : window.documentPictureInPicture.window;
        const frames = [];
        for (let i = 0; i < 25; i++) frames.push(await new Promise((resolve) => win.requestAnimationFrame(resolve)));
        return 24000 / (frames.at(-1) - frames[0]);
      }, endpoint.selector);
    }

    const input = await drawer.context.newCDPSession(drawer.page);
    const mouse = (type, point, buttons) =>
      input.send("Input.dispatchMouseEvent", {
        type,
        ...point,
        buttons,
        button: type === "mouseMoved" ? "none" : "left",
        clickCount: 1,
      });
    const trace = [];
    for (let i = 0; i < attempts; i++) {
      const x = 0.12 + (i % 10) * 0.079;
      const y = 0.12 + Math.floor(i / 10) * 0.032;
      const end = { x: x + 0.052, y };
      const start = { x, y };
      const [senderBox, ...boxes] = await Promise.all([drawer.page.evaluate(contentBox, canvas), ...surfaces.map(({ page, selector }) => page.evaluate(contentBox, selector))]);
      assert.ok(senderBox && boxes.every(Boolean), "Each surface has a decoded frame");
      await Promise.all(surfaces.map(({ page, selector }, index) => page.evaluate(startWatch, { selector, start, end, box: boxes[index] })));

      const origin = placement(senderBox, { x, y });
      const finish = placement(senderBox, end);
      await drawer.page.evaluate(() => {
        window.annotationInput = [];
      });
      await mouse("mouseMoved", origin, 0);
      const sendStart = sent.length;
      await mouse("mousePressed", origin, 1);
      for (let move = 1; move <= 8; move++) {
        const mid = placement(senderBox, { x: x + (0.026 * move) / 8, y });
        await mouse("mouseMoved", mid, 1);
        await delay(13);
      }
      await delay(70);
      await mouse("mouseReleased", finish, 0);

      await Promise.all(surfaces.map(({ page }) => page.waitForFunction(() => window.annotationPaint?.commit !== null, undefined, { timeout: 600 }).catch(() => {})));
      const [input, ...paints] = await Promise.all([drawer.page.evaluate(() => window.annotationInput), ...surfaces.map(({ page }) => page.evaluate(() => window.annotationPaint))]);
      const id = String(i + 1);
      const outgoing = sent.slice(sendStart);
      trace.push(markTrace(id, input, paints, outgoing, surfaces));
      recordPresentations(id, input, paints, surfaces);
    }
    await writeFile(join(out, "trace.json"), JSON.stringify(trace, null, 2));
  });

  const latency = surfaces.map(({ surface, samples, clock, frameRate }) => ({ id: `orb-live-viewer-to-${surface}`, surface, environment: "real_web", presentation: "frame_callback", clock, frameRate, samples }));
  await writeFile(join(out, "latency.json"), JSON.stringify({ source: synthetic ? "synthetic" : "real tab", latency }, null, 2));
  await step("Check missing samples and upper p95 against the budget", async () => {
    const summary = latency.map(({ surface, samples, clock }) => {
      const delays = samples.flatMap(({ previewPresentedMs, pointerMs }) => (previewPresentedMs === null ? [] : [previewPresentedMs - clock.receiverMinusSenderMs - pointerMs])).sort((a, b) => a - b);
      const p95 = delays[Math.ceil(delays.length * 0.95) - 1] ?? null;
      return { surface, attempts, missingPreview: attempts - delays.length, missingCommit: samples.filter(({ committedPresentedMs }) => committedPresentedMs === null).length, p95, p95Upper: p95 === null ? null : p95 + clock.uncertaintyMs };
    });
    await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2));
    for (const result of summary) {
      assert.ok(result.missingPreview <= attempts / 100 && result.missingCommit <= attempts / 100, JSON.stringify(result));
      assert.ok(result.p95Upper !== null && result.p95Upper < (result.surface === "remote" ? 150 : 200), JSON.stringify(result));
    }
  });
});

function markTrace(id, input, paints, outgoing, surfaces) {
  const mark = outgoing.find(({ type }) => type === "annotation_command")?.mark ?? outgoing.find(({ type }) => type === "annotation_presence")?.mark;
  return {
    id,
    input,
    observation: paints,
    sentPreview: outgoing.filter((frame) => frame.type === "annotation_presence").length,
    firstPreviewSentAt: outgoing.find(({ type }) => type === "annotation_presence")?.at ?? null,
    sentCommit: outgoing.some(({ type }) => type === "annotation_command"),
    received: surfaces.map(({ wire }) => ({
      preview: wire.filter(({ type, mark: id }) => id === mark && type === "annotation_presence").length,
      commit: wire.filter(({ type, mark: id }) => id === mark && type === "annotation_changed").length,
      firstPreviewAt: wire.find(({ type, mark: id }) => id === mark && type === "annotation_presence")?.at ?? null,
    })),
  };
}

function recordPresentations(id, input, paints, surfaces) {
  const pointerMs = input.find(({ type }) => type === "pointerdown")?.at ?? null;
  const releaseMs = input.find(({ type }) => type === "pointerup")?.at ?? null;
  for (const [index, endpoint] of surfaces.entries()) {
    const { preview, commit, occupied } = paints[index];
    const offset = endpoint.clock.receiverMinusSenderMs;
    endpoint.samples.push({
      id,
      pointerMs,
      releaseMs,
      previewPresentedMs: !occupied && pointerMs !== null && releaseMs !== null && preview !== null && preview - offset < releaseMs ? preview : null,
      committedPresentedMs: !occupied && releaseMs !== null && commit !== null && commit - offset >= releaseMs - endpoint.clock.uncertaintyMs ? commit : null,
    });
  }
}
