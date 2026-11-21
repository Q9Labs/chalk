import { test } from "@e2e-dev/mobile";
import { expect } from "e2e";

test("viewer draws and removes a kept mark", async ({ app, screen }) => {
  await app.open();
  await screen.getByRole("button", "Annotate").tap();
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
  await screen.getByRole("button", "Annotate").tap();
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
