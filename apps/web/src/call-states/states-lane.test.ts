// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";

let server: ChildProcess;
let browser: Browser;
let page: Page;
let watchdog: ReturnType<typeof setTimeout>;
const origin = "http://127.0.0.1:3098";
beforeAll(async () => {
  server = spawn("pnpm", ["exec", "vite", "--config", "vite.call-states.config.ts", "--port", "3098", "--strictPort"], { cwd: fileURLToPath(new URL("../..", import.meta.url)), detached: true, stdio: "ignore" });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`States harness exited ${server.exitCode}`);
    if (
      await fetch(`${origin}/call-states.html`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  watchdog = setTimeout(() => {
    if (server.pid && server.exitCode === null) process.kill(-server.pid, "SIGTERM");
  }, 240_000);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage();
}, 40_000);
afterAll(async () => {
  clearTimeout(watchdog);
  await browser?.close();
  if (server?.pid && server.exitCode === null) process.kill(-server.pid, "SIGTERM");
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
