import { test } from "@e2e-dev/mobile";
import { expect } from "e2e";

test("viewer draws and removes a kept mark", async ({ app, screen }) => {
  await app.open();
  await screen.getByRole("button", "Annotate screen").tap();
  await screen.getByRole("button", "Fade").tap();
  const title = await screen.getByText("Layout review").boundingBox();
  if (!title) throw new Error("The shared frame is not visible");

  const from = { x: title.x, y: title.y + title.height + 34 };
  const to = { x: from.x + 95, y: from.y + 45 };
  await screen.swipe({ from, to, duration: 420 });
  await expect(screen.getByText("1 committed marks")).toBeVisible();
  await screen.getByRole("button", "Mark authors").tap();
  await expect(screen.getByText("Omar")).toBeVisible();
  await screen.getByRole("button", "Mark authors").tap();

  await screen.getByRole("button", "Undo").tap();
  await expect(screen.getByText("0 committed marks")).toBeVisible();
  await screen.getByRole("button", "Redo").tap();
  await expect(screen.getByText("1 committed marks")).toBeVisible();

  await screen.getByRole("button", "Erase").tap();
  await screen.tapAt({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
  await expect(screen.getByText("0 committed marks")).toBeVisible();
});

test("viewer cannot draw while paused or after presenter revokes access", async ({ app, screen }) => {
  await app.open();
  await screen.getByRole("button", "Annotate screen").tap();
  const title = await screen.getByText("Layout review").boundingBox();
  if (!title) throw new Error("The shared frame is not visible");
  const from = { x: title.x, y: title.y + title.height + 34 };
  const to = { x: from.x + 95, y: from.y + 45 };

  const pause = screen.getByRole("button", "Toggle presenter pause");
  await pause.tap();
  await expect(screen.getByText("Marks are paused")).toBeVisible();
  await screen.swipe({ from, to, duration: 420 });
  await expect(screen.getByText("0 committed marks")).toBeVisible();
  await pause.tap();

  await screen.getByRole("button", "Toggle viewer access").tap();
  await screen.swipe({ from, to, duration: 420 });
  await expect(screen.getByText("0 committed marks")).toBeVisible();
  await screen.getByRole("button", "Request to draw").tap();
  await expect(screen.getByText("Request sent")).toBeVisible();
});

test("Android sharer can pause and clear without drawing the capture back into Chalk", { platforms: ["android"] }, async ({ app, screen }) => {
  await app.open();
  await screen.getByRole("button", "Annotate screen").tap();
  await screen.getByRole("button", "Fade").tap();
  const title = await screen.getByText("Layout review").boundingBox();
  if (!title) throw new Error("The shared frame is not visible");
  const from = { x: title.x, y: title.y + title.height + 34 };
  await screen.swipe({ from, to: { x: from.x + 95, y: from.y + 45 }, duration: 420 });
  await expect(screen.getByText("1 committed marks")).toBeVisible();

  await screen.getByRole("button", "Switch to sharer").tap();
  await expect(screen.getByText("Layout review")).not.toBeVisible();
  await screen.getByRole("button", "Pause marks").tap();
  await expect(screen.getByRole("button", "Resume marks")).toBeVisible();
  await screen.getByRole("button", "Clear all marks").tap();
  await expect(screen.getByText("0 committed marks")).toBeVisible();
  await screen.getByRole("button", "Resume marks").tap();
  await expect(screen.getByRole("button", "Pause marks")).toBeVisible();
});

test("iOS sharer can open and close picture-in-picture when the device supports it", { platforms: ["ios"] }, async ({ app, screen, device }) => {
  await app.open();
  await screen.getByRole("button", "Switch to sharer").tap();
  await expect(screen.getByRole("button", "Pause marks")).toBeVisible();

  const start = screen.getByRole("button", "Start picture-in-picture");
  // The fixture bypasses ReplayKit, not AVKit, which can be unavailable on a simulator.
  if (await start.isVisible()) {
    await start.tap();
    await expect(screen.getByRole("button", "Close picture-in-picture")).toBeVisible();
    await device.home();
    await app.open();
    await expect(screen.getByText("1 committed marks")).toBeVisible();
  }

  await screen.getByRole("button", "Switch to viewer").tap();
  await expect(screen.getByRole("button", "Close picture-in-picture")).not.toBeVisible();
  await expect(screen.getByRole("button", "Annotate screen")).toBeVisible();
});
