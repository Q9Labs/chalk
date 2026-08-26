import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { FeatureUnreachableError, FeatureUnsupportedError } from "./errors.mjs";
import { clickFloatingControl, clickVisibleControl, revealFloatingControls } from "./browser.mjs";

const PANEL_DEFINITIONS = Object.freeze({
  chat: { control: /^Chat$/i, surface: '[aria-label="Chat panel"]' },
  participants: { control: /^Participants$/i, surface: '[aria-label="Participants list"]' },
  settings: { control: /^Settings$/i, surface: '[role="dialog"][aria-label="Settings"], [data-tour="settings-panel"]' },
  info: { control: /^Space information$/i, surface: '[role="dialog"][aria-label="Space details"], [role="dialog"][aria-labelledby]' },
  reactions: { control: /^(Reactions|React)$/i, surface: '[role="toolbar"][aria-label="Reactions"], [aria-label="Reaction picker"]' },
  whiteboard: { control: /^(Whiteboard|Board)$/i, surface: '[data-chalk-whiteboard-surface="true"]:visible' },
  transcript: { control: /transcript|caption/i, surface: '[aria-label*="transcription" i], [aria-label*="caption" i]' },
});

const LAYOUT_LABELS = {
  grid: /grid/i,
  spotlight: /spotlight/i,
  presentation: /presentation/i,
};

const MICROPHONE_CONTROL = /^(Mute|Unmute)( microphone)?$/i;
const CAMERA_CONTROL = /^(Turn on camera|Turn off camera|Start Video|Stop Video|Camera)$/i;
const SCREEN_SHARE_CONTROL = /^(Share Screen|Stop Share|Share screen|Stop share|Share)$/i;
const HAND_CONTROL = /^(Raise hand|Lower hand|Raise|Lower)$/i;
const MEDIA_STATE_TIMEOUT_MS = 20_000;

async function toolbarLabels(page) {
  await revealFloatingControls(page);
  const toolbar = page.locator('[role="toolbar"][aria-label="Space controls"]:visible').last();
  return toolbar.locator("button").evaluateAll((buttons) => buttons.map((button) => ({ label: button.getAttribute("aria-label"), pressed: button.getAttribute("aria-pressed") })));
}

async function waitForControlChange(page, before, beforePressed, matcher, description) {
  const expectedPressed = beforePressed === "true" ? "false" : beforePressed === "false" ? "true" : null;
  await page
    .waitForFunction(
      ({ previous, expected, pressedTarget }) => {
        const toolbars = [...document.querySelectorAll('[role="toolbar"][aria-label="Space controls"]')].filter((toolbar) => {
          const bounds = toolbar.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0;
        });
        const toolbar = toolbars.at(-1);
        if (!toolbar) return false;
        return [...toolbar.querySelectorAll("button")].some((button) => {
          const label = button.getAttribute("aria-label") ?? "";
          const pressed = button.getAttribute("aria-pressed");
          return new RegExp(expected, "i").test(label) && (pressedTarget === null ? label !== previous : pressed === pressedTarget);
        });
      },
      { previous: before, expected: matcher.source, pressedTarget: expectedPressed },
      { timeout: 15_000 },
    )
    .catch(() => {
      throw new Error(`${description} postcondition did not change control state`);
    });
}

async function toggleControl(page, matcher, feature, description) {
  const labels = await toolbarLabels(page);
  const state = labels.find((entry) => matcher.test(entry.label ?? ""));
  const before = state?.label ?? "";
  if (!before) throw new FeatureUnreachableError(feature, `${description} control is not visible`);
  await clickFloatingControl(page, matcher, description);
  await waitForControlChange(page, before, state.pressed, matcher, description);
  const after = (await toolbarLabels(page)).find((entry) => matcher.test(entry.label ?? ""));
  return after?.pressed === "true";
}

export async function toggleMicrophone(page) {
  return toggleControl(page, MICROPHONE_CONTROL, "microphone", "microphone");
}

export async function toggleCamera(page) {
  return toggleControl(page, CAMERA_CONTROL, "camera-video", "camera-video");
}

export async function toggleScreenShare(page) {
  return toggleControl(page, SCREEN_SHARE_CONTROL, "screen-share", "screen-share");
}

export async function screenShareFailureDetail(page) {
  const controls = await toolbarLabels(page);
  const control = controls.find((entry) => SCREEN_SHARE_CONTROL.test(entry.label ?? "")) ?? null;
  const feedback = page.locator('[role="alert"]:visible, [data-sonner-toast]:visible');
  await feedback
    .first()
    .waitFor({ state: "visible", timeout: 1_000 })
    .catch(() => undefined);
  const alerts = await feedback.allTextContents();
  return JSON.stringify({ control, alerts: alerts.map((entry) => entry.trim()).filter(Boolean) });
}

export async function summarizePeerConnections(page) {
  const summary = await page.evaluate(() => {
    const collect = globalThis.__chalkPerfWebRtcDiagnostics;
    return typeof collect === "function" ? collect() : { maxPeerConnections: 0, peerConnections: [], unavailable: true };
  });
  return summary && typeof summary === "object" ? summary : { maxPeerConnections: 0, peerConnections: [], unavailable: true };
}

export async function toggleHandRaise(page) {
  return toggleControl(page, HAND_CONTROL, "hand-raise", "hand-raise");
}

export async function chooseReaction(page, emoji = "👍") {
  try {
    await clickFloatingControl(page, /^(Reactions|React)$/i, "reactions");
    const picker = page.locator('[role="toolbar"][aria-label="Reactions"]:visible, [aria-label="Reaction picker"]:visible').last();
    if (!(await picker.isVisible())) throw new FeatureUnreachableError("reactions", "reaction picker did not open");
    await clickVisibleControl(page, new RegExp(`^React with ${emoji.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "reaction option", picker);
    await page.keyboard.press("Escape");
    await page
      .waitForFunction(
        () =>
          ![...document.querySelectorAll('[role="toolbar"][aria-label="Reactions"], [aria-label="Reaction picker"]')].some((node) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          }),
        undefined,
        { timeout: 5_000 },
      )
      .catch(() => {
        throw new Error("reaction picker did not close");
      });
  } finally {
    await dismissOverlays(page);
  }
}

async function panelSurface(page, kind) {
  const definition = PANEL_DEFINITIONS[kind];
  if (kind === "settings") {
    const named = page.getByRole("dialog", { name: /^Space settings$/i });
    if ((await named.count()) > 0) return named.last();
  }
  return page.locator(definition.surface).last();
}

async function dismissOverlays(page) {
  for (let index = 0; index < 2; index += 1) {
    try {
      await page.keyboard.press("Escape");
    } catch {
      return;
    }
  }
}

async function whiteboardFailureDetail(page) {
  const control = (await toolbarLabels(page)).find((entry) => PANEL_DEFINITIONS.whiteboard.control.test(entry.label ?? "")) ?? null;
  const loading = await page
    .getByText("Loading whiteboard...", { exact: true })
    .isVisible()
    .catch(() => false);
  const alerts = await page.locator('[role="alert"]:visible').allTextContents();
  const surfaces = await page.locator('[data-chalk-whiteboard-surface="true"]:visible').count();
  const sharedWhiteboards = await page.getByLabel("Shared whiteboard", { exact: true }).count();
  return JSON.stringify({ control, loading, alerts, surfaces, sharedWhiteboards });
}

export async function openPanel(page, kind) {
  const definition = PANEL_DEFINITIONS[kind];
  if (!definition) throw new Error(`unknown panel ${kind}`);
  try {
    const click = kind === "settings" || kind === "info" ? clickVisibleControl : clickFloatingControl;
    await click(page, definition.control, `${kind} panel`);
    const surface = await panelSurface(page, kind);
    try {
      await surface.waitFor({ state: "visible", timeout: kind === "whiteboard" ? 120_000 : 10_000 });
    } catch (error) {
      if (kind !== "whiteboard") throw error;
      throw new Error(`whiteboard did not become visible after activation: ${await whiteboardFailureDetail(page)}`, { cause: error });
    }
    return surface;
  } catch (error) {
    await dismissOverlays(page);
    throw error;
  }
}

export async function closePanel(page, kind) {
  const definition = PANEL_DEFINITIONS[kind];
  if (!definition) throw new Error(`unknown panel ${kind}`);
  const surface = await panelSurface(page, kind);
  if (kind === "settings" || kind === "info" || kind === "chat" || kind === "participants") {
    const closePattern = kind === "settings" ? /^Close settings$/i : kind === "info" ? /close space details/i : kind === "chat" ? /close chat/i : /close participants panel/i;
    try {
      await clickVisibleControl(page, closePattern, `${kind} close control`, surface);
    } catch (error) {
      if (!(error instanceof FeatureUnreachableError)) throw error;
      const toggle = kind === "settings" || kind === "info" ? clickVisibleControl : clickFloatingControl;
      await toggle(page, definition.control, `${kind} panel`);
    }
  } else if (kind === "whiteboard") {
    await clickFloatingControl(page, definition.control, `${kind} panel`);
  } else {
    await page.keyboard.press("Escape");
  }
  try {
    await surface.waitFor({ state: "hidden", timeout: 10_000 });
  } catch (error) {
    if (kind !== "whiteboard") throw new Error(`${kind} panel did not close`, { cause: error });
    throw new Error(`whiteboard panel did not close: ${await whiteboardFailureDetail(page)}`, { cause: error });
  }
}

export async function waitForPanelState(page, kind, visible) {
  const definition = PANEL_DEFINITIONS[kind];
  if (!definition) throw new Error(`unknown panel ${kind}`);
  const surface = await panelSurface(page, kind);
  await surface.waitFor({ state: visible ? "visible" : "hidden", timeout: kind === "whiteboard" ? 30_000 : 10_000 });
  return surface;
}

export async function exerciseWaitingParticipantsTab(page) {
  const panel = page.locator('[aria-label="Participants list"]:visible').last();
  const waiting = panel.getByRole("tab", { name: /^Waiting/ }).first();
  if (!(await waiting.isVisible().catch(() => false))) {
    throw new FeatureUnreachableError("admission-waiting", "the local Space does not expose the Waiting participant group");
  }
  await waiting.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Participants list"] [role="tab"][aria-selected="true"]')?.textContent?.includes("Waiting"), undefined, { timeout: 8_000 });
  const inSpace = panel.getByRole("tab", { name: /^In Space/ }).first();
  await inSpace.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Participants list"] [role="tab"][aria-selected="true"]')?.textContent?.includes("In Space"), undefined, { timeout: 8_000 });
}

export async function switchLayout(page, layout) {
  await clickVisibleControl(page, /^Layout:/i, "layout selector");
  const option = page
    .getByRole("menuitemradio", { name: LAYOUT_LABELS[layout] })
    .or(page.getByRole("menuitem", { name: LAYOUT_LABELS[layout] }))
    .first();
  await option.waitFor({ state: "visible", timeout: 8_000 });
  const box = await option.boundingBox();
  if (!box || !(await option.isEnabled())) throw new Error(`${layout} layout option is not visible and enabled`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await option.click();
  await page
    .getByRole("button", { name: new RegExp(`^Layout:.*${layout}$`, "i") })
    .first()
    .waitFor({ state: "visible", timeout: 8_000 });
  await page.keyboard.press("Escape");
  await page.getByRole("menu").last().waitFor({ state: "hidden", timeout: 8_000 });
}

export async function clickAndPinTile(page, participantNamePattern = /./) {
  const tiles = page.locator('[role="button"][aria-label^="Video tile for "]:visible');
  const count = await tiles.count();
  for (let index = 0; index < count; index += 1) {
    const tile = tiles.nth(index);
    const label = await tile.getAttribute("aria-label");
    if (!participantNamePattern.test(label ?? "")) continue;
    await tile.scrollIntoViewIfNeeded();
    const wasPinned = await tile.evaluate((node) => node.classList.contains("ring-2") || node.getAttribute("data-pinned") === "true");
    await tile.click();
    await page
      .waitForFunction(
        ({ selector, previous }) => {
          const node = document.querySelector(selector);
          const pinned = node?.classList.contains(["ri", "ng-2"].join("")) || node?.getAttribute("data-pinned") === "true";
          return pinned !== previous;
        },
        {
          selector: await tile.evaluate((node) => {
            const label = node.getAttribute("aria-label");
            return `[role="button"][aria-label="${CSS.escape(label ?? "")}"]`;
          }),
          previous: wasPinned,
        },
        { timeout: 8_000 },
      )
      .catch(() => {
        throw new Error("participant tile click did not change its pinned state");
      });
    return label;
  }
  throw new FeatureUnreachableError("participant-tile-pin", "no visible participant tile matched the requested name");
}

export async function markTileDragUnsupported(page) {
  const tile = page.locator('[role="button"][aria-label^="Video tile for "]:visible').first();
  if (!(await tile.isVisible())) throw new FeatureUnreachableError("participant-tile-drag", "no visible participant tile is available");
  const draggable = await tile.getAttribute("draggable");
  if (draggable === "true") throw new Error("participant tile exposes drag support but the scenario has no drag contract");
  throw new FeatureUnsupportedError("participant-tile-drag", "Stage does not expose participant tile dragging");
}

async function waitForComposerEnabled(page, composer) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await composer.isEnabled()) return;
    await page.waitForTimeout(100);
  }
  throw new Error("chat composer did not become enabled after durable send");
}

export async function sendChatMessage(page, text) {
  const panel = page.locator('[aria-label="Chat panel"]:visible').last();
  const composer = panel.locator('[aria-label="Message"]').first();
  await composer.waitFor({ state: "visible", timeout: 8_000 });
  if (await composer.isDisabled()) throw new Error("chat composer is disabled");
  await composer.fill(text);
  await clickVisibleControl(page, /^Send message$/i, "chat send control", panel);
  await page.getByText(text, { exact: true }).last().waitFor({ state: "visible", timeout: 15_000 });
  await waitForComposerEnabled(page, composer);
}

export async function scrollChatHistory(page, bursts = 16) {
  const scroller = page.locator('[aria-label="Chat messages"]:visible').last();
  await scroller.waitFor({ state: "visible", timeout: 8_000 });
  await scroller.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const before = await scroller.evaluate((node) => ({ top: node.scrollTop, height: node.scrollHeight, client: node.clientHeight }));
  if (before.height <= before.client) throw new Error(`chat history does not overflow: ${before.height}px content in ${before.client}px viewport`);
  await scroller.hover();
  for (let index = 0; index < bursts; index += 1) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(250);
  const after = await scroller.evaluate((node) => ({ top: node.scrollTop, height: node.scrollHeight, client: node.clientHeight }));
  if (after.top >= before.top) throw new Error("chat history did not scroll toward earlier messages");
  return { before, after };
}

export async function uploadChatFile(page, filePath) {
  const panel = page.locator('[aria-label="Chat panel"]:visible').last();
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 8_000 });
  await clickVisibleControl(page, /^Attach files$/i, "chat file picker", panel);
  const chooser = await chooserPromise;
  const fileName = basename(filePath);
  await chooser.setFiles({ name: fileName, mimeType: "text/plain", buffer: await readFile(filePath) });
  const attachments = panel.locator('[aria-label="Attachments"]');
  try {
    await attachments.waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    const composerError = await panel
      .locator('[role="alert"]:visible')
      .last()
      .textContent()
      .catch(() => null);
    if (composerError) throw new Error(`chat file staging failed: ${composerError.trim()}`, { cause: error });
    throw error;
  }
  await attachments.getByText(fileName, { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  const composer = panel.locator('[aria-label="Message"]').first();
  await clickVisibleControl(page, /^Send message$/i, "send chat attachment", panel);
  const composerAlert = panel.locator('[role="alert"]:visible').last();
  await waitForChatUploadCompletion(attachments, composerAlert);
  await waitForComposerEnabled(page, composer);
  return fileName;
}

export async function waitForChatUploadCompletion(attachments, composerAlert, timeout = 15_000) {
  const completion = await Promise.race([
    attachments.waitFor({ state: "hidden", timeout }).then(() => ({ status: "sent" })),
    composerAlert.waitFor({ state: "visible", timeout }).then(async () => ({ status: "failed", message: (await composerAlert.textContent())?.trim() || "Message could not be sent." })),
  ]);
  if (completion.status === "failed") throw new Error(`chat file upload failed: ${completion.message}`);
}

async function whiteboardCanvasBounds(page) {
  const surface = page.locator('[data-chalk-whiteboard-surface="true"][data-chalk-whiteboard-ready="true"]:visible').first();
  await surface.waitFor({ state: "visible", timeout: 30_000 });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const box = await surface.evaluate((node) => {
      const interactive = node.querySelector("canvas.excalidraw__canvas.interactive");
      if (interactive) {
        const bounds = interactive.getBoundingClientRect();
        if (bounds.width > 0 && bounds.height > 0) return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      }
      let selected = null;
      let selectedArea = 0;
      for (const candidate of node.querySelectorAll("canvas")) {
        const bounds = candidate.getBoundingClientRect();
        const area = bounds.width * bounds.height;
        if (area > selectedArea) {
          selected = bounds;
          selectedArea = area;
        }
      }
      return selected ? { x: selected.x, y: selected.y, width: selected.width, height: selected.height } : null;
    });
    if (box) return box;
    await page.waitForTimeout(100);
  }
  throw new Error("whiteboard has no canvas with visible bounds");
}

async function whiteboardVisualSignature(page) {
  const surface = page.locator('[data-chalk-whiteboard-surface="true"][data-chalk-whiteboard-ready="true"]:visible').first();
  await surface.waitFor({ state: "visible", timeout: 30_000 });
  const image = await surface.screenshot({ animations: "disabled" });
  let hash = 2_166_136_261;
  for (const byte of image) hash = Math.imul(hash ^ byte, 16_777_619);
  return `${image.length}:${hash >>> 0}`;
}

export async function drawWhiteboard(page) {
  const surface = page.locator('[data-chalk-whiteboard-surface="true"][data-chalk-whiteboard-ready="true"]:visible').first();
  await surface.waitFor({ state: "visible", timeout: 30_000 });
  const initialBox = await whiteboardCanvasBounds(page);
  await page.mouse.click(initialBox.x + initialBox.width / 2, initialBox.y + initialBox.height / 2);
  await page.keyboard.press("p");
  const box = await whiteboardCanvasBounds(page);
  const before = await whiteboardVisualSignature(page);
  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.55);
  try {
    await page.mouse.down();
    for (let index = 0; index <= 24; index += 1) {
      await page.mouse.move(box.x + box.width * (0.42 + index / 160), box.y + box.height * (0.55 + Math.sin(index / 3) * 0.04));
    }
  } finally {
    await page.mouse.up();
  }
  await page.waitForTimeout(250);
  const after = await whiteboardVisualSignature(page);
  if (before === after) throw new Error("whiteboard draw did not change the visible surface");
}

export async function panZoomWhiteboard(page) {
  const box = await whiteboardCanvasBounds(page);
  const before = await whiteboardVisualSignature(page);
  try {
    await page.keyboard.down("Control");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -240);
  } finally {
    await page.keyboard.up("Control");
  }
  await page.waitForTimeout(200);
  const zoomed = await whiteboardVisualSignature(page);
  if (before === zoomed) throw new Error("whiteboard zoom did not change the visible surface");
  const panningBox = await whiteboardCanvasBounds(page);
  await page.mouse.move(panningBox.x + panningBox.width / 2, panningBox.y + panningBox.height / 2);
  await page.mouse.wheel(180, 120);
  await page.waitForTimeout(200);
  const panned = await whiteboardVisualSignature(page);
  if (zoomed === panned) throw new Error("whiteboard pan did not change the visible surface");
  await page.mouse.wheel(-180, -120);
  try {
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 240);
  } finally {
    await page.keyboard.up("Control");
  }
  await page.waitForTimeout(200);
}

async function moveWhiteboardCursor(page, moves = 80) {
  const box = await whiteboardCanvasBounds(page);
  for (let index = 0; index < moves; index += 1) {
    const ratio = index / Math.max(1, moves - 1);
    await page.mouse.move(box.x + box.width * (0.15 + ratio * 0.7), box.y + box.height * (0.3 + Math.sin(index / 5) * 0.15));
    if (index % 8 === 0) await page.waitForTimeout(20);
  }
}

export async function moveRemoteWhiteboardCursors(anchorPage, remotePages) {
  const before = await whiteboardVisualSignature(anchorPage);
  await Promise.all(remotePages.map((page) => moveWhiteboardCursor(page)));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await anchorPage.waitForTimeout(250);
    if ((await whiteboardVisualSignature(anchorPage)) !== before) return;
  }
  throw new Error("remote whiteboard cursors did not change the anchor surface");
}

export async function assertRemoteReaction(page, displayName, emoji) {
  await page
    .getByText(new RegExp(`${displayName} reacted ${emoji.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
    .first()
    .waitFor({ state: "attached", timeout: 15_000 });
}

export async function assertRemoteHand(page) {
  await page.locator('[aria-label="Hand raised"]:visible').first().waitFor({ state: "visible", timeout: 15_000 });
}

export async function assertRemoteMicrophoneState(page, displayName, active) {
  try {
    await page.waitForFunction(
      ({ name, expectedMuted }) => {
        const tileLabel = `Video tile for ${name}`;
        const tile = [...document.querySelectorAll('[aria-label^="Video tile for "]')].find((node) => node.getAttribute("aria-label") === tileLabel);
        if (!tile) return false;
        return (tile.querySelector('[aria-label="Muted"]') !== null) === expectedMuted;
      },
      { name: displayName, expectedMuted: !active },
      { timeout: MEDIA_STATE_TIMEOUT_MS },
    );
  } catch (error) {
    const expected = active ? "active with no Muted indicator" : "muted with a Muted indicator";
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`remote Participant ${displayName} microphone did not become ${expected}${detail}`);
  }
}

export async function assertRemoteCameraState(page, displayName, enabled) {
  if (enabled) {
    let frameProof;
    try {
      frameProof = await page.evaluate(
        async ({ name, timeoutMs }) => {
          const tileLabel = `Video tile for ${name}`;
          const deadline = performance.now() + timeoutMs;
          let observedVideo = null;
          let observedTrack = null;
          let observedStream = null;
          let initialFrames = null;
          let videoFrameCallbackArrived = false;

          const currentVideo = () => {
            const tile = [...document.querySelectorAll('[aria-label^="Video tile for "]')].find((node) => node.getAttribute("aria-label") === tileLabel);
            const video = tile?.querySelector("video");
            const stream = video?.srcObject ?? null;
            const tracks = typeof stream?.getVideoTracks === "function" ? stream.getVideoTracks() : [];
            const track = tracks.find((candidate) => candidate.kind === "video" && candidate.readyState === "live") ?? tracks.find((candidate) => candidate.kind === "video") ?? null;
            return { video, stream, track };
          };

          const readDecodedFrames = (video) => {
            if (typeof video?.getVideoPlaybackQuality === "function") {
              const quality = video.getVideoPlaybackQuality();
              if (Number.isFinite(quality.totalVideoFrames)) return quality.totalVideoFrames;
            }
            if (Number.isFinite(video?.webkitDecodedFrameCount)) return video.webkitDecodedFrameCount;
            return null;
          };

          const hasLiveVideoTrack = (track) => track?.kind === "video" && track.readyState === "live";
          const observe = ({ video, stream, track }) => {
            if (video === observedVideo && stream === observedStream && track === observedTrack) return;
            observedVideo = video ?? null;
            observedStream = stream;
            observedTrack = track;
            initialFrames = readDecodedFrames(video);
            videoFrameCallbackArrived = false;
            if (typeof video?.requestVideoFrameCallback === "function") {
              video.requestVideoFrameCallback(() => {
                if (observedVideo === video && observedStream === stream && observedTrack === track) videoFrameCallbackArrived = true;
              });
            }
          };

          while (performance.now() < deadline) {
            const current = currentVideo();
            observe(current);
            const { video, track } = current;
            if (video && video.classList.contains("opacity-100") && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.paused && hasLiveVideoTrack(track) && (videoFrameCallbackArrived || (initialFrames !== null && readDecodedFrames(video) > initialFrames))) {
              return { ok: true };
            }
            if (performance.now() >= deadline) break;
            await new Promise((resolve) => window.setTimeout(resolve, Math.min(100, deadline - performance.now())));
          }
          return { ok: false, reason: "the current Participant video stream did not produce a decoded frame" };
        },
        { name: displayName, timeoutMs: MEDIA_STATE_TIMEOUT_MS },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`remote Participant ${displayName} camera decoded-frame proof failed: ${detail}`);
    }
    if (!frameProof.ok) throw new Error(`remote Participant ${displayName} camera decoded-frame proof failed: ${frameProof.reason}`);
    return;
  }

  try {
    await page.waitForFunction(
      ({ name, expectedEnabled }) => {
        const tileLabel = `Video tile for ${name}`;
        const tile = [...document.querySelectorAll('[aria-label^="Video tile for "]')].find((node) => node.getAttribute("aria-label") === tileLabel);
        const video = tile?.querySelector("video");
        if (!video) return false;
        if (!expectedEnabled) return video.classList.contains("opacity-0") && video.srcObject === null && video.readyState === HTMLMediaElement.HAVE_NOTHING && video.paused;
        const tracks = typeof video.srcObject?.getVideoTracks === "function" ? video.srcObject.getVideoTracks() : [];
        return video.classList.contains("opacity-100") && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.paused && tracks.some((track) => track.kind === "video" && track.readyState === "live");
      },
      { name: displayName, expectedEnabled: enabled },
      { timeout: MEDIA_STATE_TIMEOUT_MS },
    );
  } catch (error) {
    const expected = enabled ? "enabled with a live video track" : "disabled with no attached video track";
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`remote Participant ${displayName} camera did not become ${expected}${detail}`);
  }
}

export async function assertRemoteShare(page, displayName, active = true) {
  const tile = remoteShareTile(page, displayName);
  const primary = remoteSharePrimary(page, displayName);
  if (active) {
    await Promise.any([tile.waitFor({ state: "visible", timeout: 20_000 }), primary.waitFor({ state: "visible", timeout: 20_000 })]);
    return;
  }
  await Promise.all([tile.waitFor({ state: "hidden", timeout: 20_000 }), primary.waitFor({ state: "hidden", timeout: 20_000 })]);
}

export async function zoomPanScreenShare(page, displayName) {
  const tile = remoteShareTile(page, displayName);
  if (await tile.isVisible()) await tile.click();
  const surface = remoteSharePrimary(page, displayName);
  await surface.waitFor({ state: "visible", timeout: 20_000 });
  await surface.hover();
  const video = surface.locator("video").first();
  const before = await video.evaluate((node) => node.parentElement?.getAttribute("style") ?? "");
  await clickVisibleControl(page, /^Zoom in$/i, "screen share zoom in", surface);
  await clickVisibleControl(page, /^Zoom in$/i, "screen share zoom in", surface);
  await surface.getByRole("button", { name: /^Reset zoom$/i }).waitFor({ state: "visible", timeout: 8_000 });
  const zoomed = await video.evaluate((node) => node.parentElement?.getAttribute("style") ?? "");
  if (zoomed === before) throw new Error("screen share zoom did not change the video transform");
  const box = await video.boundingBox();
  if (!box) throw new Error("screen share video has no visible bounds");
  try {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2 + 80, { steps: 80 });
  } finally {
    await page.mouse.up();
  }
  const panned = await video.evaluate((node) => node.parentElement?.getAttribute("style") ?? "");
  if (panned === zoomed) throw new Error("screen share pan did not change the video transform");
  await clickVisibleControl(page, /^Reset zoom$/i, "screen share reset zoom", surface);
}

function remoteShareTile(page, displayName) {
  return page.getByRole("button", { name: `Screen share tile for ${displayName}`, exact: true }).first();
}

function remoteSharePrimary(page, displayName) {
  return page.getByRole("region", { name: `Screen shared by ${displayName}`, exact: true }).first();
}

export async function leaveSpace(page) {
  await clickFloatingControl(page, /^Leave( space)?$/i, "leave Space");
  const dialog = page.getByRole("dialog").last();
  await dialog.waitFor({ state: "visible", timeout: 8_000 });
  await clickVisibleControl(page, /^Leave( space)?$/i, "leave confirmation", dialog);
  await page.locator('[data-chalk-status="left"]').waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: /^Try again$/i }).waitFor({ state: "visible", timeout: 30_000 });
}

export function panelKinds() {
  return Object.keys(PANEL_DEFINITIONS);
}
