import type {} from "./follow-pin-fixture";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startCallHarness } from "./browser-harness";
import { showCallControls } from "../../tests/call-controls.mjs";

let browser: Browser;
let origin: string;
let stop: (() => Promise<void>) | undefined;
const artifacts = process.env.FOLLOW_PIN_PROOF_DIR;
const baseline = Boolean(process.env.FOLLOW_PIN_BASELINE);
beforeAll(async () => {
  ({ origin, stop } = await startCallHarness());
  browser = await chromium.launch({ headless: true });
  if (artifacts) await mkdir(artifacts, { recursive: true });
}, 60_000);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await stop?.();
  }
});
async function mount(page: Page, self: "a" | "b", room: string) {
  await page.goto(`${origin}/call-states.html?state=integration-call`);
  await page.addScriptTag({ type: "module", url: `${origin}/src/call-states/follow-pin-fixture.tsx` });
  await page.evaluate(() => customElements.whenDefined("chalk-follow-pin-fixture"));
  await page.evaluate(({ self, room }) => document.createElement("chalk-follow-pin-fixture").mount(self, room), { self, room });
  await page.getByRole("button", { name: `Video tile for ${self === "a" ? "Amina" : "Omar"}` }).waitFor();
}
async function shot(page: Page, file: string) {
  if (artifacts) await page.screenshot({ path: resolve(artifacts, file) });
}
async function people(page: Page) {
  const header = page.getByRole("button", { name: /^People, / });
  if (await header.isVisible()) await header.click();
  else {
    await page.getByRole("button", { name: "More options", exact: true }).click();
    await page.getByRole("button", { name: "People", exact: true }).click();
  }
}
async function menu(page: Page, name: string, action: string) {
  await page.getByRole("button", { name: `More options for ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

it.skipIf(!baseline)("reproduces the production tile click starting Follow instead of pinning", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await mount(page, "b", "before-pin");
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await page.getByLabel("Follow Amina", { exact: true }).click();
    await expect.poll(() => page.locator('[data-stage-item="whiteboard"]').getAttribute("data-stage-role")).toBe("primary");
    await page.locator(".chalk-board-chip").filter({ hasText: "Following Amina" }).waitFor();
    await shot(page, "before-click.png");
  } finally {
    await context.close();
  }
});

it.skipIf(baseline).each([
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
])(
  "pins separately from menu Follow at $width px",
  async (viewport) => {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    try {
      const [a, b] = await Promise.all([context.newPage(), context.newPage()]);
      const room = `pin-${viewport.width}`;
      await a.setViewportSize({ width: 1440, height: 900 });
      await a.clock.install();
      await mount(a, "a", room);
      await mount(b, "b", room);
      // Loading the sibling can outlast the three-second desktop controls timer.
      await a.clock.fastForward(3100);
      await a.locator('[data-part="call-frame"][data-idle="true"]').waitFor();
      await showCallControls(a);
      await a.getByRole("button", { name: "Board", exact: true }).click();
      const followed = b.locator('.chalk-board-chip[role="status"]').filter({ hasText: "Following Amina" });
      await followed.waitFor();
      await expect.poll(() => a.locator('[data-part="tile-following"]').count()).toBe(0);
      await expect
        .poll(() =>
          b
            .locator('[data-part="toast"]')
            .filter({ hasText: /following/i })
            .count(),
        )
        .toBe(0);
      await shot(b, `after-auto-${viewport.width}.png`);
      const canvas = a.locator(".excalidraw canvas.interactive");
      const bounds = await canvas.boundingBox();
      if (!bounds) throw new Error("Missing teacher canvas");
      await a.getByRole("button", { name: "Pen", exact: true }).click();
      await a.mouse.move(bounds.x + bounds.width * 0.45, bounds.y + bounds.height / 2);
      await a.mouse.down();
      await a.mouse.move(bounds.x + bounds.width * 0.55, bounds.y + bounds.height / 2, { steps: 8 });
      await a.mouse.up();
      await expect.poll(() => b.locator(".chalk-board").getAttribute("data-elements")).toBe("1");
      const pixels = () =>
        b.locator(".excalidraw canvas.static").evaluate((canvas) => {
          if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Missing follower canvas");
          return canvas.toDataURL();
        });
      const beforePan = await pixels();
      await a.getByRole("button", { name: "Hand", exact: true }).click();
      await a.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await a.mouse.down();
      await a.mouse.move(bounds.x + bounds.width / 2 + 140, bounds.y + bounds.height / 2, { steps: 8 });
      await a.mouse.up();
      await expect.poll(pixels).not.toBe(beforePan);
      await shot(b, `after-pan-${viewport.width}.png`);
      await b.getByRole("button", { name: "More options for Amina", exact: true }).click();
      await b.getByRole("menuitem", { name: "Stop following", exact: true }).waitFor();
      await shot(b, `after-menu-${viewport.width}.png`);
      await b.getByRole("menuitem", { name: "Stop following", exact: true }).click();
      await expect.poll(() => followed.count()).toBe(0);
      await shot(b, `after-stopped-${viewport.width}.png`);
      await menu(b, "Amina", "Follow");
      await followed.waitFor();
      await shot(b, `after-follow-${viewport.width}.png`);
      await b.getByRole("button", { name: "Video tile for Amina", exact: true }).click();
      await expect.poll(() => b.locator('[data-stage-item="a"]').getAttribute("data-stage-role")).toBe("primary");
      await expect
        .poll(() =>
          b
            .locator('[data-part="toast"]')
            .filter({ hasText: /following/i })
            .count(),
        )
        .toBe(0);
      await shot(b, `after-pin-${viewport.width}.png`);
      await b.getByRole("button", { name: "Video tile for Amina", exact: true }).click();
      await expect.poll(() => b.locator('[data-stage-item="whiteboard"]').getAttribute("data-stage-role")).toBe("primary");
      await menu(b, "Amina", "Stop following");
      await a.getByRole("button", { name: "Zoom in", exact: true }).click();
      await expect.poll(() => followed.count()).toBe(0);
      await people(b);
      await b.getByRole("button", { name: "Show Amina on main screen", exact: true }).click();
      await expect.poll(() => b.locator('[data-stage-item="a"]').getAttribute("data-stage-role")).toBe("primary");
      await expect.poll(() => b.locator('[data-part="tile-following"]').count()).toBe(0);
      await shot(b, `after-people-${viewport.width}.png`);
      if (viewport.width < 640) await people(b);
      await b.getByRole("button", { name: "Show Amina on main screen", exact: true }).click();
      await expect.poll(() => b.locator('[data-stage-item="a"]').getAttribute("data-pinned")).toBeNull();
      if (viewport.width < 640) await people(b);
      await b.getByRole("button", { name: "Options for Amina", exact: true }).click();
      await b.locator('.chalk-menu[aria-label="Options for Amina"]').getByText("Volume", { exact: true }).click();
      await b
        .locator('.chalk-menu[aria-label="Options for Amina"]')
        .locator(".cursor-pointer")
        .click({ position: { x: 30, y: 10 }, timeout: 2000 });
      await expect.poll(() => b.locator('[data-stage-item="a"]').getAttribute("data-pinned")).toBeNull();
      await b.getByRole("button", { name: "Show Amina on main screen", exact: true }).waitFor();
      await b.keyboard.press("Escape");
      if (viewport.width >= 640) {
        await b.getByRole("button", { name: "Video tile for Amina", exact: true }).click();
        await b.getByRole("button", { name: "Switch to grid", exact: true }).click();
        await expect.poll(() => b.locator('[data-stage-item="a"]').getAttribute("data-stage-role")).toBe("grid");
        await b.getByRole("button", { name: "Video tile for Amina", exact: true }).click();
        await expect.poll(() => b.locator('[data-stage-item="a"]').getAttribute("data-stage-role")).toBe("primary");
        await b.getByRole("button", { name: "Switch to grid", exact: true }).waitFor();
        await b.getByRole("button", { name: "Video tile for Amina", exact: true }).click();
        await expect.poll(() => b.locator('[data-stage-item="a"]').getAttribute("data-stage-role")).toBe("grid");
      }
    } finally {
      await context.close();
    }
  },
  60_000,
);
