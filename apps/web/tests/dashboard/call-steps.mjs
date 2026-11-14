/** Starts a call from Home as the signed-in owner, joins it, and waits for the video grid. */
export async function startAndJoinCall(page, origin) {
  await page.goto(`${origin}/dashboard`);
  await page.getByRole("button", { name: "Start a call", exact: true }).first().click();
  await page.getByRole("button", { name: "Join call", exact: true }).click();
  await page.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
}
