import { expect } from "e2e";
import { test } from "@e2e-dev/web";
import { createRequire } from "node:module";
import { devices, type BrowserType } from "playwright";
import { webMediaFixture } from "../scripts/web-proof/media.mjs";

// The journey launches the web engine's own browsers. This repo's `playwright` ships an older WebKit that refuses
// TURN URLs with `?transport=`, so a page opened from it cannot join a call, while the engine's WebKit can.
const engineBrowsers: Record<"chromium" | "webkit", BrowserType> = createRequire(createRequire(import.meta.url).resolve("@e2e-dev/web"))("playwright-core");

// A visitor on a tablet who was never asked for the camera and microphone sees the access sheet first.
// This is the first-run state in Safari, so the proof starts from permission "prompt" and goes through the sheet.
test("a tablet visitor who was never asked allows the camera and joins the call", async () => {
  const invite = process.env.CHALK_E2E_INVITE;
  if (!invite) throw new Error("Run pnpm web:proof to provision and clean the proof Space");
  const ipad = devices["iPad Pro 11"];
  const browser = await engineBrowsers[process.env.CHALK_PROOF_WEBKIT === "1" ? "webkit" : "chromium"].launch();
  try {
    const context = await browser.newContext({ viewport: ipad.viewport, userAgent: ipad.userAgent });
    await context.addInitScript(webMediaFixture(2, { permission: "prompt" }));
    const page = await context.newPage();
    await page.goto(new URL(invite, process.env.CHALK_PROOF_WEB_URL ?? "http://localhost:3000").href);
    // Typing before the page hydrates loses the name, so type until the form accepts it.
    const name = page.getByLabel("Your name", { exact: true });
    const join = page.getByRole("button", { name: "Join call", exact: true });
    await expect
      .poll(async () => {
        await name.fill("Prompt proof");
        return join.isEnabled();
      })
      .toBe(true);
    const sheet = page.getByRole("dialog", { name: "Camera and microphone" });
    await sheet.waitFor();
    await sheet.getByRole("button", { name: "Turn on", exact: true }).click();
    await expect.poll(() => sheet.count()).toBe(0);
    await join.click();
    const stage = page.getByRole("region", { name: "Space stage", exact: true });
    await stage.waitFor({ timeout: 30_000 });
    await stage.hover();
    await page.getByRole("button", { name: "Leave call", exact: true }).click();
  } finally {
    await browser.close();
  }
});
