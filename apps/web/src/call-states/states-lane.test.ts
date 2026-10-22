// @vitest-environment node
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startCallHarness } from "./browser-harness";
import type { CallStateClient } from "./fixtures";

declare global {
  interface Window {
    __terminalTestClient: CallStateClient;
    __mediaTestClient: CallStateClient;
    __mediaCalls: boolean[];
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

it("asks for a name, and Join call waits for one", async () => {
  await page.goto(`${origin}/call-states.html?state=name-needed`);
  const name = page.getByLabel("Your name");
  const join = page.getByRole("button", { name: "Join call", exact: true });
  await name.fill("");
  expect(await join.isDisabled()).toBe(true);
  await name.fill("Nora");
  expect(await join.isEnabled()).toBe(true);
});

it.each(
  [
    { width: 1440, height: 900, card: 320 },
    { width: 390, height: 844, card: 300 },
    { width: 844, height: 390, card: 320 },
  ].flatMap((size) => (["dark", "light"] as const).map((theme) => ({ ...size, theme }))),
)("lays out the name card as in the mockup at $width by $height in $theme", async ({ width, height, card, theme }) => {
  await page.setViewportSize({ width, height });
  try {
    await page.goto(`${origin}/call-states.html?state=${theme === "dark" ? "name-needed" : "name-needed-light"}`);
    const name = page.getByLabel("Your name");
    const label = page.locator('label[for="join-display-name"]');
    const [box, field, button, tag] = await Promise.all([page.locator('[data-part="limbo-message"]'), name, page.getByRole("button", { name: "Join call", exact: true }), label].map((element) => element.boundingBox()));
    // The mockup's card has a 1px border and 20px padding, and the label, field and button fill its content box.
    expect(box?.width).toBe(card);
    for (const control of [field, button, tag]) expect(control?.x).toBe((box?.x ?? 0) + 21);
    expect([field?.width, button?.width]).toEqual([card - 42, card - 42]);
    // The join button is 44px tall and sits 14px under the field.
    expect([field?.height, button?.height]).toEqual([44, 44]);
    expect((button?.y ?? 0) - ((field?.y ?? 0) + (field?.height ?? 0))).toBe(14);
    // The label and the card share the page's theme, so the label stays readable.
    const contrast = await label.evaluate((element) => {
      const card = element.closest('[data-part="limbo-message"]');
      if (!card) throw new Error("The label is outside the limbo card.");
      const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      if (!canvas) throw new Error("The contrast check requires Canvas 2D.");
      const luminance = (color: string) => {
        canvas.clearRect(0, 0, 1, 1);
        canvas.fillStyle = color;
        canvas.fillRect(0, 0, 1, 1);
        const [r = 0, g = 0, b = 0] = canvas.getImageData(0, 0, 1, 1).data;
        const [lr, lg, lb] = [r, g, b].map((value) => (value / 255 <= 0.03928 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4));
        return 0.2126 * (lr ?? 0) + 0.7152 * (lg ?? 0) + 0.0722 * (lb ?? 0);
      };
      const [text, background] = [luminance(getComputedStyle(element).color), luminance(getComputedStyle(card).backgroundColor)];
      return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
  }
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
      ["media.capture_failed", `Couldn’t change your ${source} settings`],
      ["client.internal_error", `Couldn’t change your ${source} settings. Try again.`],
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

it.each([
  { gesture: "camera shortcut", source: "camera", key: "Control+e", release: false },
  { gesture: "microphone shortcut", source: "microphone", key: "Control+d", release: false },
  { gesture: "push-to-talk press", source: "microphone", key: "Space", release: false },
  { gesture: "push-to-talk release", source: "microphone", key: "Space", release: true },
])(
  "keeps internal errors out of the $gesture toast",
  async ({ source, key, release }) => {
    const boundary = "**/src/call-states/states-lane.tsx";
    await page.route(boundary, async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      expect(body).toContain("return createCallStateClient(");
      await route.fulfill({ response, body: body.replace("return createCallStateClient(", "return window.__mediaTestClient = createCallStateClient(") });
    });
    try {
      await page.goto(`${origin}/call-states.html?state=states-events`);
      await page.locator('[data-part="call-frame"]').waitFor();
      await page.evaluate(
        ({ source, release }) => {
          const client = window.__mediaTestClient;
          window.__mediaCalls = [];
          client.updateSnapshot((current) => ({ ...current, media: { ...current.media, local: { ...current.media.local, microphone: { ...current.media.local.microphone, state: "disabled" } } } }));
          const reject = async (enabled: boolean) => {
            window.__mediaCalls.push(enabled);
            if (release && enabled) return;
            throw new Error(source === "camera" ? "setCameraEnabled belongs to an inactive connection" : "setMicrophoneEnabled belongs to an inactive connection");
          };
          if (source === "camera") client.media.setCameraEnabled = reject;
          else client.media.setMicrophoneEnabled = reject;
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        },
        { source, release },
      );
      if (key === "Space") {
        await page.keyboard.down(key);
        if (release) await page.keyboard.up(key);
      } else await page.keyboard.press(key);
      const notice = page.getByRole("alert").filter({ hasText: `Couldn’t change your ${source} settings.` });
      await notice.waitFor({ timeout: 5_000 });
      expect(await page.getByRole("alert").allTextContents()).not.toEqual(expect.arrayContaining([expect.stringMatching(/setCameraEnabled|setMicrophoneEnabled|inactive connection/)]));
      expect(await page.evaluate(() => window.__mediaCalls)).toEqual(release ? [true, false] : [source !== "camera"]);
    } finally {
      await page.keyboard.up("Space");
      await page.unroute(boundary);
    }
  },
  30_000,
);
