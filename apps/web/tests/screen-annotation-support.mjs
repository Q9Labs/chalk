export async function keepMarks(page) {
  await page.getByRole("button", { name: "More", exact: true }).click();
  const fade = page.getByRole("menuitemcheckbox", { name: "Marks fade" });
  if ((await fade.getAttribute("aria-checked")) === "true") await fade.click();
  await page.keyboard.press("Escape");
}
