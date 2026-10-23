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
  const alert = page.getByRole("alert").filter({ hasText: "setCameraEnabled belongs to an inactive connection" });
  await alert.waitFor();
  await page.getByRole("button", { name: "Reactions", exact: true }).click();
  await page.getByRole("button", { name: "React with 👍", exact: true }).click();
  await page.waitForFunction(() => window.__toastLayering.state().reactions.includes("👍"));
  await page.getByRole("button", { name: "Reactions", exact: true }).click();
  const hand = page.getByRole("button", { name: "Raise hand", exact: true });
  await hand.click();
  await page.waitForFunction(() => window.__toastLayering.state().raised);
  await page.evaluate(() => window.__toastLayering.peerHand());
  await page.getByRole("status").filter({ hasText: "Nora raised a hand" }).waitFor();
  await hand.click();
  await page.waitForFunction(() => !window.__toastLayering.state().raised);
  const reactions = await page.evaluate(() => window.__toastLayering.state().reactions);
  if (screenshotDirectory) await page.screenshot({ path: `${screenshotDirectory}/${label}-${width}x${height}.png` });
  if (place === "header") {
    await page.locator("[data-part='notice-button']").click();
    const list = page.getByRole("dialog", { name: "Notices" });
    await list.locator("[data-part='notice']", { hasText: "setCameraEnabled belongs to an inactive connection" }).getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.keyboard.press("Escape");
    await list.waitFor({ state: "hidden" });
  } else await alert.getByRole("button", { name: "Dismiss", exact: true }).click();
  await alert.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => window.__toastLayering.state().reactions), reactions, "Dismiss must not send a reaction");
  await page.keyboard.press("Escape");
  await page.locator(".chalk-shell-reactions").waitFor({ state: "detached" });
  assert.equal(await page.locator(".chalk-toasts").evaluate((element) => getComputedStyle(element).marginBottom), "0px", "Closing the tray must restore the notice baseline");
}
