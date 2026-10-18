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
