import { strict as assert } from "node:assert";
import { showCallControls } from "../call-controls.mjs";

/** @param {import("playwright").Page} page
 * @param {string} origin
 */
export async function leaveOwnerCall(page, origin) {
  // The video grid can render before Sync supplies the owner's capabilities.
  const leave = page.locator('button[aria-label="Leave call"][aria-haspopup="menu"]');
  await leave.waitFor();
  await showCallControls(page);
  const [response] = await Promise.all([
    page.waitForResponse(`${origin}/auth/clear-owner-seats`),
    (async () => {
      await leave.click();
      await page.getByRole("menuitem", { name: "Leave call", exact: true }).click();
    })(),
  ]);
  assert.equal(response.status(), 200);
}
