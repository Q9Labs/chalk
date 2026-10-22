// @vitest-environment node
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startCallHarness } from "./browser-harness";
import type { CallStateClient } from "./fixtures";

declare global {
  interface Window {
    __terminalTestClient: CallStateClient;
  }
}

let origin: string;
let stop: (() => Promise<void>) | undefined;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  ({ origin, stop } = await startCallHarness());
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage();
}, 40_000);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await stop?.();
  }
});

it("joining exposes consent; the ready card copies the link and announces Copied", async () => {
  await page.goto(`${origin}/call-states.html?state=states-joining-recorded`);
  await page.getByRole("status").filter({ hasText: "Joining Q9 team" }).waitFor();
  expect(await page.getByText("This call is recorded. By joining, you agree to be recorded.").isVisible()).toBe(true);
  await page.goto(`${origin}/call-states.html?state=states-ready`);
  await page.getByRole("heading", { name: "Your call is ready" }).waitFor();
  await page.getByRole("button", { name: "Copy link", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Copied$/ })
    .waitFor();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("state=states-ready");
  await page.getByRole("button", { name: "Show QR code" }).click();
  expect(await page.getByRole("img", { name: "Scan to join this call" }).isVisible()).toBe(true);
}, 30_000);

it("asks for a name in a full-width form, and Join call waits for one", async () => {
  await page.goto(`${origin}/call-states.html?state=name-needed`);
  const name = page.getByLabel("Your name");
  const join = page.getByRole("button", { name: "Join call", exact: true });
  await name.fill("");
  expect(await join.isDisabled()).toBe(true);
  await name.fill("Nora");
  expect(await join.isEnabled()).toBe(true);
  // As in the mockup, the label, the field and the button share one left edge and one width.
  const [label, field, button] = await Promise.all([page.locator('label[for="join-display-name"]'), name, join].map((element) => element.boundingBox()));
  expect(field?.width).toBeGreaterThanOrEqual(264);
  expect(button?.width).toBe(field?.width);
  expect([label?.x, button?.x]).toEqual([field?.x, field?.x]);
  // The mockup's join button is 44px tall and sits 14px under the field.
  expect(button?.height).toBe(44);
  expect((button?.y ?? 0) - ((field?.y ?? 0) + (field?.height ?? 0))).toBe(14);
});

it("announces a join, raised hand and recording through event toasts", async () => {
  await page.goto(`${origin}/call-states.html?state=states-events`);
  for (const event of [
    { control: "Simulate join", notice: /joined$/ },
    { control: "Simulate raised hand", notice: /raised a hand/ },
    { control: "Simulate recording", notice: /Recording started/ },
  ]) {
    await page.getByRole("button", { name: event.control, exact: true }).click();
    const toast = page.getByRole("status").filter({ hasText: event.notice }).first();
    await toast.waitFor();
    expect(await toast.getAttribute("aria-live")).toBe("polite");
  }
}, 30_000);

it("explains how to allow a blocked camera and allows dismissal", async () => {
  await page.goto(`${origin}/call-states.html?state=states-events`);
  await page.getByRole("button", { name: "Simulate blocked camera" }).click();
  const toast = page.getByRole("alert");
  await toast.waitFor();
  expect(await toast.textContent()).toContain("Click the camera icon in the address bar and allow Camera.");
  await toast.getByRole("button", { name: "Dismiss" }).click();
  await toast.waitFor({ state: "detached" });
}, 30_000);

it("leaves at once, then Rejoin returns to the call", async () => {
  await page.goto(`${origin}/call-states.html?state=states-events`);
  await page.getByRole("button", { name: "Leave fixture call" }).click();
  await page.getByRole("heading", { name: "You left Q9 team" }).waitFor();
  expect(await page.getByRole("dialog").count()).toBe(0);
  await page.getByRole("button", { name: "Rejoin", exact: true }).click();
  await page.locator('[data-part="call-frame"]').waitFor();
}, 30_000);

it("takes the call back with Use here and hides the unconfigured report link", async () => {
  await page.goto(`${origin}/call-states.html?state=states-elsewhere`);
  await page.getByRole("heading", { name: "You joined from another tab" }).waitFor();
  expect(await page.getByRole("button", { name: "Report a problem" }).count()).toBe(0);
  await page.getByRole("button", { name: "Use here", exact: true }).click();
  await page.locator('[data-part="call-frame"]').waitFor();
}, 30_000);

it("maps typed command failures to source-specific recovery guidance", async () => {
  await page.goto(`${origin}/call-states.html?state=states-command-failures`);
  for (const source of ["camera", "microphone"]) {
    await page.getByRole("button", { name: source, exact: true }).click();
    for (const [code, copy] of [
      ["media.permission_denied", `Chalk can’t use your ${source}. Click the camera icon in the address bar and allow ${source === "camera" ? "Camera" : "Microphone"}.`],
      ["media.device_not_found", `No ${source} found`],
      ["media.device_busy", `Your ${source} is being used by another app`],
      ["media.device_constraint_invalid", `Your ${source} doesn’t support these settings`],
      ["media.capture_failed", `Your ${source} couldn’t start`],
      ["client.internal_error", "The command could not be completed"],
    ]) {
      await page.getByRole("button", { name: code, exact: true }).click();
      await page.getByRole("alert").filter({ hasText: copy }).waitFor();
    }
  }
  await page.getByRole("button", { name: "screen", exact: true }).click();
  await page.getByRole("button", { name: "media.permission_denied", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Allow screen recording for your browser in System Settings" }).waitFor();
  await page.getByRole("alert").getByRole("button", { name: "Dismiss" }).click();
  await page.getByRole("alert").waitFor({ state: "detached" });
}, 30_000);

it("reopens the controlled call link and restores trigger focus when closed", async () => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(`${origin}/call-states.html?state=states-link-controls`);
    await page.getByRole("heading", { name: "Your call is ready" }).first().waitFor();
    await page.getByRole("button", { name: "Close call link" }).click();
    const trigger = page.getByRole("button", { name: "Show call link", exact: true });
    await trigger.waitFor();
    expect(await trigger.getAttribute("aria-pressed")).toBe("false");
    await expect.poll(() => trigger.evaluate((element) => element === document.activeElement)).toBe(true);
    await trigger.click();
    await page.getByRole("button", { name: "Close call link" }).waitFor();
    if (width === 1440) await page.getByRole("button", { name: "Hide call link", exact: true }).click();
    else await page.getByRole("button", { name: "Close call link" }).click();
    await trigger.waitFor();
    await trigger.click();
    if (width === 1440) {
      await page.getByRole("button", { name: "Someone joins" }).click();
      await trigger.waitFor();
      await page.getByRole("button", { name: "Everyone leaves" }).click();
      expect(await trigger.getAttribute("aria-pressed")).toBe("false");
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}, 30_000);

it("waits two seconds for reconnecting without blocking message input", async () => {
  await page.goto(`${origin}/call-states.html?state=states-reconnecting-input`);
  expect(await page.getByRole("status").count()).toBe(0);
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("Before reconnect notice");
  await page.getByRole("status").filter({ hasText: "Reconnecting…" }).waitFor();
  await message.fill("Still writing while reconnecting");
  expect(await message.inputValue()).toBe("Still writing while reconnecting");
  expect(await message.evaluate((element) => element === document.activeElement)).toBe(true);
}, 30_000);

it("names the blocked camera when its error arrives before the media snapshot", async () => {
  await page.goto(`${origin}/call-states.html?state=states-events`);
  await page.getByRole("button", { name: "Simulate blocked camera", exact: true }).click();
  const notice = page.getByRole("alert");
  await notice.waitFor();
  expect(await notice.count()).toBe(1);
  expect(await notice.textContent()).toContain("Chalk can’t use your camera. Click the camera icon in the address bar and allow Camera.");
}, 30_000);

it("shows Ended without retrying an already-ended call", async () => {
  await page.goto(`${origin}/call-states.html?state=states-ended-join`);
  await page.getByRole("heading", { name: "The call ended", exact: true }).waitFor();
  expect(await page.getByRole("button", { name: "Try again", exact: true }).count()).toBe(0);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  expect(new URL(page.url()).hash).toBe("#home");
}, 30_000);

it("plays exactly one error cue for join, rejected in-call toggle, and overlapping routes", async () => {
  await page.goto(`${origin}/call-states.html?state=states-failure-sounds`);
  const count = page.getByLabel("Error cue count");
  for (const [index, control] of ["Emit join error", "Reject in-call camera", "Emit both failure routes"].entries()) {
    await page.getByRole("button", { name: control, exact: true }).click();
    await page.waitForTimeout(50);
    expect(await count.textContent()).toBe(String(index + 1));
  }
}, 30_000);

it.each([
  { episodeEnded: false, removedByHost: true, title: "You were removed from Test call", rejoin: false },
  { episodeEnded: false, removedByHost: false, title: "You left Test call", rejoin: true },
  { episodeEnded: true, removedByHost: false, title: "The call ended", rejoin: false },
  { episodeEnded: true, removedByHost: true, title: "The call ended", rejoin: false },
])(
  "preserves terminal flags through the real web page: $title",
  async ({ episodeEnded, removedByHost, title, rejoin }) => {
    const boundary = "**/src/call-states/web-space-boundary.ts";
    await page.route(boundary, async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      expect(body).toContain("return createCallStateClient(");
      await route.fulfill({ response, body: body.replace("return createCallStateClient(", "return window.__terminalTestClient = createCallStateClient(") });
    });
    try {
      await page.goto(`${origin}/web-space-journey.html`);
      await page.getByTestId("stage").waitFor();
      await page.evaluate(
        (flags) => {
          const client = window.__terminalTestClient;
          client.updateSnapshot((current) => ({ ...current, connection: { ...current.connection, status: "leaving", ...flags } }));
          client.updateSnapshot((current) => ({ ...current, connection: { ...current.connection, status: "left", ...flags } }));
        },
        { episodeEnded, removedByHost },
      );
      await page.getByRole("heading", { name: title, exact: true }).waitFor({ timeout: 5_000 });
      expect(await page.getByRole("button", { name: "Rejoin", exact: true }).count()).toBe(rejoin ? 1 : 0);
    } finally {
      await page.unroute(boundary);
    }
  },
  30_000,
);
