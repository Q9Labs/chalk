// Scripted 30-45 min meeting scenario for the Chalk web perf harness.
// Selectors verified against the live classic skin (aria-labels harvested from
// the rendered control bar). Control clicks use dispatched events because two
// stacked toolbars make hit-testing unreliable in headless runs.
// Every step is best-effort: a missing control is logged and skipped so one
// absent feature never aborts the whole run.

const ENTRANCE = {
  nameInput: 'input[placeholder="Enter your name"]',
  enterButton: "Enter Space",
  ready: '[data-tour="video-grid"]',
};

async function tryStep(logger, label, fn, { optional = true } = {}) {
  const startedAt = Date.now();
  try {
    await fn();
    logger({ event: "step", label, ok: true, ms: Date.now() - startedAt });
    return true;
  } catch (error) {
    if (!optional) throw error;
    logger({ event: "step", label, ok: false, skipped: true, ms: Date.now() - startedAt, reason: String(error).slice(0, 200) });
    return false;
  }
}

function controlButton(page, labelPattern) {
  const pattern = labelPattern instanceof RegExp ? labelPattern : new RegExp(`^${labelPattern}$`, "i");
  return page.getByRole("button", { name: pattern }).first();
}

async function clickControl(page, labelPattern) {
  const button = controlButton(page, labelPattern);
  await button.waitFor({ state: "attached", timeout: 8_000 });
  await button.dispatchEvent("click");
}

async function fillEntranceName(page, displayName) {
  // With ?name= prefilling the field there may be no placeholder to match.
  const byPlaceholder = page.getByPlaceholder("Enter your name");
  const input = (await byPlaceholder.count()) ? byPlaceholder : page.locator('input[type="text"], input:not([type])').first();
  await input.waitFor({ state: "visible", timeout: 30_000 });
  const value = await input.inputValue().catch(() => "");
  if (!value) await input.fill(displayName);
}

export async function joinAsHost(page, displayName, onEvent = () => {}) {
  await page.goto(`/space?name=${encodeURIComponent(displayName)}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  try {
    await fillEntranceName(page, displayName);
  } catch (error) {
    const dump = `/tmp/chalk-join-fail-${Date.now()}.png`;
    await page.screenshot({ path: dump, fullPage: true }).catch(() => {});
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 400) ?? "").catch(() => "");
    onEvent({ label: "join-failed", url: page.url(), text, shot: dump });
    throw error;
  }
  await page.getByRole("button", { name: ENTRANCE.enterButton }).click();
  await page.locator(ENTRANCE.ready).first().waitFor({ state: "visible", timeout: 90_000 });
  void onEvent;
  // The app rewrites the address bar to /space/<slug>#spaceInviteToken=…
  return new URL(page.url());
}

export async function joinWithInvite(page, inviteURL, displayName) {
  const url = new URL(inviteURL);
  url.searchParams.set("name", displayName);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 120_000 });
  await fillEntranceName(page, displayName);
  await page.getByRole("button", { name: ENTRANCE.enterButton }).click();
  await page.locator(ENTRANCE.ready).first().waitFor({ state: "visible", timeout: 90_000 });
}

export async function leaveViaDialog(page) {
  // Toolbar "Leave" opens LeaveDialog; confirm inside the labelled dialog.
  const dialog = page.locator('[aria-labelledby="leave-modal-title"], [role="dialog"]');
  const leaveButton = page.getByRole("button", { name: /^Leave( space)?$/i }).last();
  await leaveButton.click({ force: true, timeout: 10_000 }).catch(async () => {
    await leaveButton.dispatchEvent("click");
  });
  const confirm = dialog.getByRole("button", { name: /^Leave/i }).first();
  await confirm.waitFor({ state: "attached", timeout: 5_000 });
  await confirm.dispatchEvent("click");
}

// --- Feature steps ---

export function toggleMic(page) {
  return clickControl(page, /^(Mute|Unmute)( microphone)?$/i);
}

export function toggleCamera(page) {
  return clickControl(page, /^(Turn (on|off) camera|(Start|Stop) Video)$/i);
}

export function toggleScreenShare(page) {
  return clickControl(page, /^(Share|Stop share|Share Screen|Stop Share)$/i);
}

export function toggleHandRaise(page) {
  return clickControl(page, /^((Raise|Lower)( hand)?)$/i);
}

export async function sendReaction(page, emoji = "👍") {
  await clickControl(page, /^React$/i);
  const emojiButton = page.locator(`[aria-label="React with ${emoji}"]`).first();
  await emojiButton.waitFor({ state: "attached", timeout: 6_000 });
  await emojiButton.dispatchEvent("click");
  await page.keyboard.press("Escape").catch(() => {});
}

const PANEL_TOGGLE_LABELS = {
  chat: /^Chat$/i,
  participants: /^Participants$/i,
  settings: /^Settings$/i,
};

export async function openPanel(page, kind) {
  if (kind === "transcript") {
    await clickControl(page, /transcript|captions/i);
    return page.locator('[aria-label="Live transcription"]').waitFor({ state: "visible", timeout: 4_000 });
  }
  const toggle = PANEL_TOGGLE_LABELS[kind];
  if (!toggle) throw new Error(`unknown panel ${kind}`);
  await clickControl(page, toggle);
  await page.waitForTimeout(700); // panel transition
}

export async function closeTopmost(page) {
  const closeSettings = page.getByRole("button", { name: /close settings/i }).first();
  if (await closeSettings.isVisible().catch(() => false)) {
    await closeSettings.dispatchEvent("click");
    return;
  }
  // Panels toggle closed via their same toolbar buttons.
  for (const kind of ["chat", "participants"]) {
    const panelOpen = await page
      .locator(kind === "chat" ? '[aria-label="Chat panel"]' : '[aria-label="Participants list"]')
      .isVisible()
      .catch(() => false);
    if (panelOpen) {
      await clickControl(page, PANEL_TOGGLE_LABELS[kind]);
      return;
    }
  }
  await page.keyboard.press("Escape");
}

export async function sendChatMessage(page, text) {
  const composer = page.locator('[aria-label="Message"]').first();
  // The composer is disabled while staged attachments are processed.
  await composer.waitFor({ state: "visible", timeout: 6_000 });
  await page
    .waitForFunction(
      () => {
        const node = document.querySelector('[aria-label="Message"]');
        return node instanceof HTMLTextAreaElement && !node.disabled;
      },
      { timeout: 15_000 },
    )
    .catch(() => {});
  await composer.fill(text, { timeout: 6_000 });
  const send = page.locator('[aria-label="Send message"]').first();
  await send.dispatchEvent("click");
}

export async function scrollChatHistory(page, direction = "up", times = 3) {
  const scroller = page.locator('[aria-label="Chat messages"]').first();
  await scroller.hover({ timeout: 5_000 });
  for (let index = 0; index < times; index += 1) {
    await page.mouse.wheel(0, direction === "up" ? -600 : 600);
    await page.waitForTimeout(120);
  }
}

export async function uploadChatFile(page, filePath) {
  const input = page.locator('[aria-label="Choose attachments"]').first();
  await input.setInputFiles(filePath, { timeout: 6_000 });
}

export async function switchLayout(page, layout) {
  const trigger = page.getByRole("button", { name: /^Layout:/i }).first();
  await trigger.click({ force: true, timeout: 6_000 });
  const option = page
    .getByRole("menuitemradio", { name: new RegExp(layout, "i") })
    .or(page.getByRole("menuitem", { name: new RegExp(layout, "i") }))
    .first();
  await option.waitFor({ state: "attached", timeout: 5_000 });
  await option.dispatchEvent("click");
  await page.waitForTimeout(400);
}

export async function dragOnStage(page, box, dx, dy) {
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 12 });
  await page.mouse.up();
}

export async function whiteboardToggle(page) {
  return clickControl(page, /^Board$|^Whiteboard$/i);
}

async function whiteboardCanvas(page) {
  const canvas = page.locator("canvas:visible").last();
  await canvas.waitFor({ state: "visible", timeout: 30_000 });
  return canvas;
}

export async function whiteboardDraw(page, strokes = 2) {
  const target = await whiteboardCanvas(page);
  const box = await target.boundingBox({ timeout: 6_000 });
  if (!box) throw new Error("whiteboard canvas has no box");
  for (let stroke = 0; stroke < strokes; stroke += 1) {
    const baseX = box.x + box.width * (0.25 + 0.08 * stroke);
    const baseY = box.y + box.height * 0.35;
    await page.mouse.move(baseX, baseY);
    await page.mouse.down();
    for (let step = 0; step <= 20; step += 1) {
      await page.mouse.move(baseX + step * 6, baseY + Math.sin(step / 3) * 24, { steps: 1 });
      await page.waitForTimeout(8);
    }
    await page.mouse.up();
    await page.waitForTimeout(120);
  }
}

export async function whiteboardPanZoom(page) {
  const target = await whiteboardCanvas(page);
  const box = await target.boundingBox({ timeout: 6_000 });
  if (!box) throw new Error("no canvas for pan/zoom");
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -240);
  await page.mouse.wheel(0, 240);
  await page.keyboard.up("Control");
  await page.keyboard.down(" ");
  await dragOnStage(page, box, 140, 60);
  await dragOnStage(page, box, -140, -60);
  await page.keyboard.up(" ");
}

export async function stageTileInteractions(page) {
  // Tiles are not draggable; exercise pointer pipelines over the stage grid.
  const stage = page.locator('[data-tour="video-grid"]').first();
  const box = await stage.boundingBox({ timeout: 5_000 });
  if (!box) throw new Error("stage not visible");
  await dragOnStage(page, box, 80, 30);
}
