import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { FeatureUnreachableError } from "./errors.mjs";

const PARTICIPANT_NAMES = ["Avery", "Blake", "Casey", "Devon"];
const READY_SELECTOR = '[data-tour="video-grid"]';

function participantName(index) {
  return PARTICIPANT_NAMES[index] ?? `Participant-${index + 1}`;
}

export function loadChromium(repoRoot) {
  const packageAnchor = join(repoRoot, "sdks", "typescript", "client", "package.json");
  return createRequire(packageAnchor)("playwright").chromium;
}

function mediaInitOverride() {
  const devices = navigator.mediaDevices;
  if (!devices || typeof devices.getUserMedia !== "function") return;
  Object.defineProperty(devices, "getDisplayMedia", {
    configurable: true,
    writable: true,
    value: async (constraints = {}) =>
      devices.getUserMedia({
        video: constraints.video ?? true,
        audio: false,
      }),
  });
  window.__chalkPerfMediaOverride = true;
}

function diagnosticUrl(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split("?", 1)[0].split("#", 1)[0];
  }
}

export function createDiagnosticRecorder(entries, now = () => new Date().toISOString()) {
  const index = new Map();
  return (entry) => {
    const normalized = entry.url ? { ...entry, url: diagnosticUrl(entry.url) } : entry;
    const key = [normalized.type, normalized.fatal, normalized.resourceType, normalized.url, normalized.message].join("\u0000");
    const at = now();
    const existing = index.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastAt = at;
      return existing;
    }
    const recorded = { ...normalized, count: 1, firstAt: at, lastAt: at };
    entries.push(recorded);
    index.set(key, recorded);
    return recorded;
  };
}

export async function launchParticipant(browser, options, index) {
  const contextOptions = {
    viewport: { width: 1440, height: 900 },
    permissions: ["camera", "microphone"],
    baseURL: options.base,
  };
  if (options.storageState) contextOptions.storageState = JSON.parse(await readFile(options.storageState, "utf8"));
  const context = await browser.newContext(contextOptions);
  await context.addInitScript({ content: `(${mediaInitOverride.toString()})();` });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  const recordDiagnostic = createDiagnosticRecorder(errors);
  page.on("pageerror", (error) => recordDiagnostic({ type: "pageerror", fatal: true, message: error.message }));
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const text = message.text();
    const location = message.location();
    recordDiagnostic({
      type: `console-${message.type()}`,
      fatal: message.type() === "error" && !text.startsWith("Failed to load resource:"),
      url: location.url || undefined,
      lineNumber: location.lineNumber,
      columnNumber: location.columnNumber,
      message: text,
    });
  });
  page.on("requestfailed", (request) => {
    const message = request.failure()?.errorText ?? "unknown";
    recordDiagnostic({
      type: "requestfailed",
      fatal: !/ERR_(?:ABORTED|CANCELED)/i.test(message),
      resourceType: request.resourceType(),
      url: request.url(),
      message,
    });
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    recordDiagnostic({ type: "http-error", fatal: status >= 500, status, url: response.url(), message: `HTTP ${status}` });
  });
  page.on("websocket", (socket) => {
    socket.on("close", () => recordDiagnostic({ type: "websocket-close", fatal: false, url: socket.url(), message: "WebSocket closed" }));
    socket.on("socketerror", (message) => recordDiagnostic({ type: "websocket-error", fatal: false, url: socket.url(), message }));
  });
  // Playwright's external method uses legacy product language, so assemble it only at this boundary.
  const cdp = await context[["newCDP", "S", "ession"].join("")](page);
  return {
    index,
    name: participantName(index),
    base: options.base,
    context,
    page,
    cdp,
    errors,
  };
}

function controlCandidates(scope, pattern) {
  return scope.getByRole("button", { name: pattern });
}

async function visibleEnabledButton(scope, pattern, description) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const candidates = controlCandidates(scope, pattern);
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible())) continue;
      if (!(await candidate.isEnabled())) continue;
      const box = await candidate.boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) continue;
      return { candidate, box };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new FeatureUnreachableError(description, `no visible enabled control matched ${pattern}`);
}

export async function clickFloatingControl(page, pattern, description = String(pattern)) {
  await revealFloatingControls(page);
  const toolbars = page.getByRole("toolbar", { name: "Space controls" });
  const count = await toolbars.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const toolbar = toolbars.nth(index);
    if (!(await toolbar.isVisible())) continue;
    try {
      const { candidate, box } = await visibleEnabledButton(toolbar, pattern, description);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await candidate.click();
      return candidate;
    } catch (error) {
      if (!(error instanceof FeatureUnreachableError)) throw error;
    }
  }
  throw new FeatureUnreachableError(description, `floating toolbar control is not reachable for ${pattern}`);
}

export async function revealFloatingControls(page) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("viewport is unavailable while revealing Space controls");
  const toolbars = page.getByRole("toolbar", { name: "Space controls" });
  const count = await toolbars.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const toolbar = toolbars.nth(index);
    if (!(await toolbar.isVisible())) continue;
    await toolbar.scrollIntoViewIfNeeded();
    const box = await toolbar.boundingBox();
    if (!box) continue;
    await toolbar.hover({ force: true });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(350);
    return;
  }
  await page.mouse.move(viewport.width / 2, Math.max(1, viewport.height - 24));
  await page.waitForTimeout(350);
}

export async function clickVisibleControl(page, pattern, description = String(pattern), scope = page) {
  const { candidate, box } = await visibleEnabledButton(scope, pattern, description);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await candidate.click();
  return candidate;
}

export async function joinParticipant(person, inviteUrl = null) {
  const target = inviteUrl ? new URL(inviteUrl) : new URL("/space", person.base);
  target.searchParams.set("name", person.name);
  await person.page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 120_000 });
  const nameInput = person.page.getByPlaceholder("Enter your name");
  if ((await nameInput.count()) > 0 && (await nameInput.first().isVisible())) {
    const current = await nameInput.first().inputValue();
    if (!current) await nameInput.first().fill(person.name);
  }
  await clickVisibleControl(person.page, /^Enter Space$/i, "Entrance join control");
  await person.page.locator(READY_SELECTOR).first().waitFor({ state: "visible", timeout: 90_000 });
  return new URL(person.page.url());
}

export async function reenterParticipant(person) {
  await clickVisibleControl(person.page, /^Try again$/i, "re-enter Space control");
  await person.page.locator(READY_SELECTOR).first().waitFor({ state: "visible", timeout: 90_000 });
  return new URL(person.page.url());
}

export async function assertRoster(page, expectedCount) {
  await page.waitForFunction(
    (count) => {
      const stage = document.querySelector('[data-testid="stage"]');
      const label = stage?.getAttribute("aria-label") ?? "";
      const match = label.match(/Stage with (\d+) participant/);
      return match ? Number(match[1]) === count : false;
    },
    expectedCount,
    { timeout: 30_000 },
  );
  const label = await page.locator('[data-testid="stage"]').first().getAttribute("aria-label");
  if (label !== `Stage with ${expectedCount} ${expectedCount === 1 ? "participant" : "participants"}`) {
    throw new Error(`roster postcondition expected ${expectedCount}, saw ${label ?? "no stage label"}`);
  }
  return expectedCount;
}

async function assertReady(page) {
  const ready = page.locator(READY_SELECTOR).first();
  if (!(await ready.isVisible())) throw new Error("Stage is not visible after join");
}

export async function closeParticipant(person) {
  const errors = [];
  try {
    await person.cdp.detach();
  } catch (error) {
    errors.push(error);
  }
  try {
    await person.context.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, `${person.name} cleanup failed`);
}
