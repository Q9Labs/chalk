import { expect } from "e2e";
import { test, type Browser } from "@e2e-dev/web";

const canvas = '[data-part="screen-annotation-layer"]';

const bounds = () => {
  const box = document.querySelector('[data-part="screen-annotation-layer"]')?.getBoundingClientRect();
  return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
};

function hasInk() {
  const canvas = document.querySelector('[data-part="screen-annotation-layer"]');
  if (!(canvas instanceof HTMLCanvasElement)) return false;
  return (
    canvas
      .getContext("2d")
      ?.getImageData(0, 0, canvas.width, canvas.height)
      .data.some((alpha, index) => index % 4 === 3 && alpha > 50) ?? false
  );
}

async function stroke(browser: Browser, portion = 0.38) {
  const box = await browser.evaluate(bounds);
  if (!box) throw new Error("Annotation canvas did not mount");
  const y = box.y + box.height * portion;
  await browser.mouse.move(box.x + box.width * 0.3, y);
  await browser.mouse.down();
  for (const ratio of [0.38, 0.47, 0.53, 0.64]) await browser.mouse.move(box.x + box.width * ratio, y);
  await browser.mouse.up();
  await browser.mouse.move(10, 10);
}

test("draw, fade, keep, undo, redo, save, download and clear a matched publication", async ({ app, browser, screen }) => {
  await browser.goto("/call-states.html?state=screen-annotation");
  await screen.getByRole("button", "Annotate", { exact: true }).click();
  await stroke(browser);
  await expect.poll(() => browser.evaluate(hasInk), { timeout: 1500 }).toBe(true);
  await expect.poll(() => browser.evaluate(hasInk), { timeout: 3500 }).toBe(false);

  await screen.getByRole("button", "Keep new marks", { exact: true }).click();
  await stroke(browser, 0.54);
  await expect.poll(() => browser.evaluate(hasInk)).toBe(true);
  await screen.getByRole("button", "Undo mark", { exact: true }).click();
  await expect.poll(() => browser.evaluate(hasInk)).toBe(false);
  await screen.getByRole("button", "Redo mark", { exact: true }).click();
  await expect.poll(() => browser.evaluate(hasInk)).toBe(true);
  await screen.getByRole("button", "Save frame to board", { exact: true }).click();
  await expect(browser.locator('[role="status"]').filter({ hasText: "1 accepted marks sent to board" })).toBeVisible();
  const png = await browser.waitForDownload(() => screen.getByRole("button", "Download annotated PNG", { exact: true }).click());
  expect(png.suggestedFilename).toBe("chalk-annotated-screen.png");
  await app.screenshot("viewer-kept-fit");
  await screen.getByRole("button", "Fill the tile", { exact: true }).click();
  await expect.poll(() => browser.evaluate(hasInk)).toBe(true);
  await app.screenshot("viewer-kept-fill");
  await screen.getByRole("button", "Clear my marks", { exact: true }).click();
  await expect.poll(() => browser.evaluate(hasInk)).toBe(false);
});

test("revoke during a gesture, raise a hand to draw, approve and fall back when loopback is denied", async ({ app, browser, screen }) => {
  await browser.goto("/call-states.html?state=screen-annotation");
  await screen.getByRole("button", "Annotate", { exact: true }).click();
  const box = await browser.evaluate(bounds);
  if (!box) throw new Error("Annotation canvas did not mount");
  await browser.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await browser.mouse.down();
  await browser.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4);
  await browser.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === "Require approval");
    button?.click();
    return Boolean(button);
  });
  await browser.mouse.up();
  await expect(screen.getByRole("button", "Annotate", { exact: true })).not.toBeVisible();
  await expect.poll(() => browser.evaluate(hasInk)).toBe(false);
  await screen.getByRole("button", "Raise hand to draw", { exact: true }).click();
  await expect(screen.getByRole("button", "Request sent", { exact: true })).toBeDisabled();
  await app.screenshot("viewer-request");

  await screen.getByRole("button", "View as Sara", { exact: true }).click();
  await screen.getByRole("button", "Who can draw · 1 requested", { exact: true }).click();
  await screen.getByRole("button", "Allow Omar to draw", { exact: true }).click();
  await browser.keyboard.press("Escape");
  await screen.getByRole("button", "View as Omar", { exact: true }).click();
  await screen.getByRole("button", "Annotate", { exact: true }).click();
  await screen.getByRole("button", "Keep new marks", { exact: true }).click();
  await stroke(browser);
  await screen.getByRole("button", "View as Sara", { exact: true }).click();
  await expect.poll(() => browser.evaluate(hasInk)).toBe(true);
  await screen.getByRole("button", "Connect Chalk Helper", { exact: true }).click();
  await expect(browser.locator('[role="status"]').filter({ hasText: "Couldn’t reach Chalk Helper on this device." })).toBeVisible();
  await browser.locator("input[autocomplete=off]").fill("HJKX-4821");
  await screen.getByRole("button", "Find device", { exact: true }).click();
  await expect(browser.locator('[data-part="annotation-helper-offer"]')).toContainText("Allow Demo Mac to show marks on this share?");
  await screen.getByRole("button", "Allow this device", { exact: true }).click();
  await expect(browser.locator('[role="status"]').filter({ hasText: "Marks show on your screen" })).toBeVisible();
  await app.screenshot("sharer-helper-approval");
  await screen.getByRole("button", "End share", { exact: true }).click();
  await expect(browser.locator(canvas)).not.toBeVisible();
  await expect(browser.locator('[data-part="annotation-helper-offer"]')).not.toBeVisible();
});
