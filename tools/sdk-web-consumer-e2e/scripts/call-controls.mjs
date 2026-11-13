// Resting call controls fade and ignore the pointer until it moves, so move it
// the way a person would before reaching for the dock.
export async function showCallControls(page) {
  const { width, height } = page.viewportSize();
  await page.mouse.move(width / 2, height / 2);
  await page.mouse.move(width / 2 + 10, height / 2 + 10);
  await page.getByRole("toolbar", { name: "Space controls", exact: true }).hover();
}
