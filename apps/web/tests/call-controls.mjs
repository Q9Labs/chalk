/** Wake auto-hidden call controls as a person returning to the call would.
 * @param {import("playwright").Page} page
 */
export async function showCallControls(page) {
  await page.bringToFront();
  await page.mouse.move(0, 0);
  await page.locator('[data-part="call-frame"]').hover({ position: { x: 10, y: 10 } });
}
