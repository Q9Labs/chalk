import type { Page } from "playwright";

// A desktop tile has a More button and a menu; a phone has no button, so a tap on the tile opens its options sheet.
export async function chooseTileOption(page: Page, name: string, option: string) {
  const more = page.getByLabel(`More options for ${name}`, { exact: true });
  if (await more.count()) {
    await more.click();
    await page.getByRole("menuitem", { name: option, exact: true }).click();
    return;
  }
  await page.getByRole("button", { name: `Video tile for ${name}`, exact: true }).click();
  await page.getByRole("button", { name: option, exact: true }).click();
}
