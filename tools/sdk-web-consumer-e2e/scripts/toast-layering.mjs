import { strict as assert } from "node:assert";

export async function proveToastLayering(browser, baseURL, { screenshotDirectory, label = "layering", noticeBottom } = {}) {
  const failures = [];
  for (const [width, height, place] of [
    [1440, 900, "stage"],
    [390, 844, "stage"],
    // A call shorter than 620px keeps its notices behind the header's notice button.
    [844, 390, "header"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
    page.setDefaultTimeout(3000);
    try {
      await proveViewport(page, baseURL, { screenshotDirectory, label, noticeBottom, width, height, place });
      console.log(`[toast-layering] ${label} ${width}x${height}: passed`);
    } catch (error) {
      failures.push(`${width}x${height}: ${error.message}`);
      console.error(`[toast-layering] ${label} ${width}x${height}: ${error.message}`);
    } finally {
      await page.close();
    }
  }
  assert.equal(failures.length, 0, failures.join("\n"));
}

async function proveViewport(page, baseURL, { screenshotDirectory, label, noticeBottom, width, height, place }) {
  const url = new URL(baseURL);
  url.searchParams.set("fixture", "toast-layering");
  await page.goto(url.href);
  if (noticeBottom !== undefined) await page.addStyleTag({ content: `.chalk-toasts { bottom: ${noticeBottom}px; }` });
  const error = "setCameraEnabled belongs to an inactive connection";
  // One text-only announcer handles speech in both placements; visual notices own interactions.
  const notice = (text, live) => (place === "header" ? page.locator(`[data-part='notice-announcer'] [aria-live='${live}']`, { hasText: text }) : page.locator("[data-part=toast]").filter({ hasText: text }));
  const alert = notice(error, "assertive");
  await alert.waitFor();
  await page.locator("[data-part=notice-announcer] [aria-live=assertive]", { hasText: error }).waitFor();
  await page.getByRole("button", { name: "Reactions", exact: true }).click();
  await page.getByRole("button", { name: "React with 👍", exact: true }).click();
  await page.waitForFunction(() => window.__toastLayering.state().reactions.includes("👍"));
  await page.getByRole("button", { name: "Reactions", exact: true }).click();
  const hand = page.getByRole("button", { name: "Raise hand", exact: true });
  await hand.click();
  await page.waitForFunction(() => window.__toastLayering.state().raised);
  await page.evaluate(() => window.__toastLayering.peerHand());
  await notice("Nora raised a hand", "polite").waitFor();
  await page.locator("[data-part=notice-announcer] [aria-live=polite]", { hasText: "Nora raised a hand" }).waitFor();
  await hand.click();
  await page.waitForFunction(() => !window.__toastLayering.state().raised);
  const reactions = await page.evaluate(() => window.__toastLayering.state().reactions);
  if (screenshotDirectory) await page.screenshot({ path: `${screenshotDirectory}/${label}-${width}x${height}.png` });
  if (place === "header") {
    await page.locator("[data-part='notice-button']").click();
    const list = page.getByRole("dialog", { name: "Notices" });
    const row = list.locator("[data-part='notice']", { hasText: error });
    await row.getByRole("button", { name: "Dismiss", exact: true }).click();
    await row.waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    await list.waitFor({ state: "hidden" });
    // Escape handed focus back to the notice button, whose tooltip would take the next Escape before the tray.
    await page.evaluate(() => document.activeElement.blur());
    await page.locator("[data-part='tooltip']").waitFor({ state: "hidden" });
  } else {
    await alert.getByRole("button", { name: "Dismiss", exact: true }).click();
    await alert.waitFor({ state: "detached" });
  }
  assert.deepEqual(await page.evaluate(() => window.__toastLayering.state().reactions), reactions, "Dismiss must not send a reaction");
  await page.keyboard.press("Escape");
  await page.locator(".chalk-shell-reactions").waitFor({ state: "detached" });
  assert.equal(await page.locator(".chalk-toasts").evaluate((element) => getComputedStyle(element).marginBottom), "0px", "Closing the tray must restore the notice baseline");
}
