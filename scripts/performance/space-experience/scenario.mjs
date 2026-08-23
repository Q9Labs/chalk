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
  whiteboard: { control: /^(Whiteboard|Board)$/i, surface: '[aria-label="Shared whiteboard"], .excalidraw' },
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

async function toolbarLabels(page) {
  await revealFloatingControls(page);
  const toolbar = page.locator('[role="toolbar"][aria-label="Space controls"]:visible').last();
  return toolbar.locator("button").evaluateAll((buttons) => buttons.map((button) => ({ label: button.getAttribute("aria-label"), pressed: button.getAttribute("aria-pressed") })));
}

async function waitForControlChange(page, before, beforePressed, matcher, description) {
  await page
    .waitForFunction(
      ({ previous, previousPressed, expected }) => {
        const controls = [...document.querySelectorAll('[role="toolbar"][aria-label="Space controls"] button')];
        return controls.some((button) => {
          const label = button.getAttribute("aria-label") ?? "";
          const pressed = button.getAttribute("aria-pressed");
          return new RegExp(expected, "i").test(label) && (label !== previous || (previousPressed !== null && pressed !== previousPressed));
        });
      },
      { previous: before, previousPressed: beforePressed, expected: matcher.source },
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
  await toggleControl(page, MICROPHONE_CONTROL, "microphone", "microphone");
}

export async function toggleCamera(page) {
  return toggleControl(page, CAMERA_CONTROL, "camera-video", "camera-video");
}

export async function toggleScreenShare(page) {
  return toggleControl(page, SCREEN_SHARE_CONTROL, "screen-share", "screen-share");
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

export async function openPanel(page, kind) {
  const definition = PANEL_DEFINITIONS[kind];
  if (!definition) throw new Error(`unknown panel ${kind}`);
  try {
    const click = kind === "settings" || kind === "info" ? clickVisibleControl : clickFloatingControl;
    await click(page, definition.control, `${kind} panel`);
    const surface = await panelSurface(page, kind);
    await surface.waitFor({ state: "visible", timeout: kind === "whiteboard" ? 30_000 : 10_000 });
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
  await surface.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {
    throw new Error(`${kind} panel did not close`);
  });
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
  await attachments.waitFor({ state: "visible", timeout: 10_000 });
  await attachments.getByText(fileName, { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  const composer = panel.locator('[aria-label="Message"]').first();
  await clickVisibleControl(page, /^Send message$/i, "send chat attachment", panel);
  await panel.locator('[aria-label="Attachments"]').waitFor({ state: "hidden", timeout: 15_000 });
  await waitForComposerEnabled(page, composer);
  return fileName;
}

async function whiteboardCanvas(page) {
  const canvases = page.locator(".excalidraw canvas:visible");
  await canvases.first().waitFor({ state: "visible", timeout: 30_000 });
  const count = await canvases.count();
  let selected = null;
  let selectedArea = 0;
  for (let index = 0; index < count; index += 1) {
    const candidate = canvases.nth(index);
    const box = await candidate.boundingBox();
    const area = box ? box.width * box.height : 0;
    if (area > selectedArea) {
      selected = candidate;
      selectedArea = area;
    }
  }
  if (!selected) throw new Error("whiteboard has no canvas with visible bounds");
  return selected;
}

async function canvasSignature(canvas) {
  return canvas.evaluate((node) => {
    const data = node.toDataURL();
    let hash = 2_166_136_261;
    for (let index = 0; index < data.length; index += 97) hash = Math.imul(hash ^ data.charCodeAt(index), 16_777_619);
    return `${data.length}:${hash >>> 0}`;
  });
}

export async function drawWhiteboard(page) {
  const canvas = await whiteboardCanvas(page);
  const box = await canvas.boundingBox();
  if (!box) throw new Error("whiteboard canvas has no visible bounds");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  try {
    await clickVisibleControl(page, /^(Draw|Free draw)$/i, "whiteboard draw tool");
  } catch (error) {
    if (!(error instanceof FeatureUnreachableError)) throw error;
    await page.keyboard.press("p");
  }
  const before = await canvasSignature(canvas);
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.35);
  try {
    await page.mouse.down();
    for (let index = 0; index <= 24; index += 1) {
      await page.mouse.move(box.x + box.width * (0.25 + index / 180), box.y + box.height * (0.35 + Math.sin(index / 3) * 0.04));
    }
  } finally {
    await page.mouse.up();
  }
  await page.waitForTimeout(250);
  const after = await canvasSignature(canvas);
  if (before === after) throw new Error("whiteboard draw did not change the canvas");
}

export async function panZoomWhiteboard(page) {
  const canvas = await whiteboardCanvas(page);
  const box = await canvas.boundingBox();
  if (!box) throw new Error("whiteboard canvas has no visible bounds");
  const before = await canvasSignature(canvas);
  try {
    await page.keyboard.down("Control");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -240);
  } finally {
    await page.keyboard.up("Control");
  }
  await page.waitForTimeout(200);
  const zoomed = await canvasSignature(canvas);
  if (before === zoomed) throw new Error("whiteboard zoom did not redraw the canvas");
  try {
    await page.keyboard.down(" ");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 12 });
  } finally {
    await page.mouse.up();
    await page.keyboard.up(" ");
  }
  await page.waitForTimeout(200);
  const panned = await canvasSignature(canvas);
  if (zoomed === panned) throw new Error("whiteboard pan did not redraw the canvas");
}

async function moveWhiteboardCursor(page, moves = 80) {
  const canvas = await whiteboardCanvas(page);
  const box = await canvas.boundingBox();
  if (!box) throw new Error("whiteboard canvas has no visible bounds");
  for (let index = 0; index < moves; index += 1) {
    const ratio = index / Math.max(1, moves - 1);
    await page.mouse.move(box.x + box.width * (0.15 + ratio * 0.7), box.y + box.height * (0.3 + Math.sin(index / 5) * 0.15));
  }
}

export async function moveRemoteWhiteboardCursors(anchorPage, remotePages) {
  const anchorCanvas = await whiteboardCanvas(anchorPage);
  const before = await canvasSignature(anchorCanvas);
  await Promise.all(remotePages.map((page) => moveWhiteboardCursor(page)));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await anchorPage.waitForTimeout(250);
    if ((await canvasSignature(anchorCanvas)) !== before) return;
  }
  throw new Error("remote whiteboard cursors did not redraw the anchor canvas");
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

export async function assertRemoteCameraState(page, displayName, enabled) {
  await page.waitForFunction(
    ({ name, expected }) => {
      const tile = document.querySelector(`[aria-label="${CSS.escape(`Video tile for ${name}`)}"]`);
      const video = tile?.querySelector("video");
      return Boolean(video?.classList.contains("opacity-100")) === expected;
    },
    { name: displayName, expected: enabled },
    { timeout: 20_000 },
  );
}

export async function assertRemoteShare(page, displayName, active = true) {
  const badge = page.getByText(`Shared by ${displayName}`, { exact: true }).first();
  await badge.waitFor({ state: active ? "visible" : "hidden", timeout: 20_000 });
}

export async function zoomPanScreenShare(page, displayName) {
  const badge = page.getByText(`Shared by ${displayName}`, { exact: true }).first();
  await badge.waitFor({ state: "visible", timeout: 20_000 });
  const surface = badge.locator("..");
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
