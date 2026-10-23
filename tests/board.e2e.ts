import { expect } from "e2e";
import { test } from "@e2e-dev/web";
import { withProofCall } from "../scripts/web-proof/guest.mjs";

const boardBox = () => {
  const box = document.querySelector(".chalk-board")?.getBoundingClientRect();
  return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
};
const zoomLabel = () => document.querySelector(".chalk-board-zoom-value")?.textContent ?? "";

// The web app joins by invite, so it can draw but not manage the board. The SDK guest is an
// owner: it opens the board, draws, and brings everyone to its view.
test("the board syncs strokes, sticky notes, follow and bring everyone between two browsers", async ({ app, browser, screen }) => {
  await withProofCall({ app, screen }, async (guest) => {
    await guest.ready;
    await guest.board.open();
    await expect(screen.getByRole("toolbar", "Drawing tools", { exact: true })).toBeVisible();

    // A pen stroke and a sticky note from the web reach the guest.
    const box = await browser.evaluate(boardBox);
    if (!box) throw new Error("The board did not open in the web app");
    await screen.getByRole("button", "Pen", { exact: true }).click();
    await screen.swipe({ from: { x: box.x + box.width * 0.3, y: box.y + box.height * 0.3 }, to: { x: box.x + box.width * 0.5, y: box.y + box.height * 0.4 }, duration: 400 });
    await screen.getByRole("button", "Sticky note", { exact: true }).click();
    await screen.tapAt({ x: box.x + box.width * 0.6, y: box.y + box.height * 0.6 });
    await browser.locator("textarea.excalidraw-wysiwyg").pressSequentially("Ship Friday");
    await browser.locator("textarea.excalidraw-wysiwyg").press("Escape");
    await expect.poll(async () => (await guest.board.elements()).some((element) => element.type === "freedraw"), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await guest.board.elements()).some((element) => element.note), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await guest.board.elements()).some((element) => element.text === "Ship Friday"), { timeout: 15_000 }).toBe(true);

    // A stroke from the guest reaches the web board.
    const elementCount = () => Number(document.querySelector(".chalk-board")?.getAttribute("data-elements") ?? 0);
    const before = await browser.evaluate(elementCount);
    await guest.board.draw();
    await expect.poll(() => browser.evaluate(elementCount), { timeout: 15_000 }).toBe(before + 1);

    // Following the guest by its tile moves the web view with the guest's view.
    await screen.getByLabel("Follow Proof").click();
    const following = screen.getByRole("status").filter({ hasText: "Following Proof" });
    await expect(following).toBeVisible();
    expect(await guest.board.view({ x: 0, y: 0, width: 4000, height: 2500, bring: false })).toBe(true);
    await expect.poll(() => browser.evaluate(zoomLabel), { timeout: 15_000 }).not.toBe("100%");
    const wide = await browser.evaluate(zoomLabel);
    expect(await guest.board.view({ x: 100, y: 100, width: 400, height: 250, bring: false })).toBe(true);
    await expect.poll(() => browser.evaluate(zoomLabel), { timeout: 15_000 }).not.toBe(wide);
    await screen.getByRole("button", "Stop", { exact: true }).click();
    await expect(following).not.toBeVisible();

    // Bring everyone makes the web follow the guest again, with a toast that says who did it.
    expect(await guest.board.view({ x: 0, y: 0, width: 2000, height: 1250, bring: true })).toBe(true);
    await expect(screen.getByText("Proof brought everyone to this view")).toBeVisible();
    await expect(following).toBeVisible();
    await app.screenshot("board-web");

    await screen.getByRole("button", "Leave call", { exact: true }).click();
    await guest.leave();
  });
});
