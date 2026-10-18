import { expect } from "e2e";
import { test } from "@e2e-dev/web";
import { prepareGuest } from "../scripts/web-proof/guest.mjs";
import { incomingAudioLevel, remoteVideoFrames } from "../scripts/web-proof/media.mjs";

// The web app has invite entry, not account sign-in. The runner authenticates to
// the proof Tenant to create this Space; the browser never receives its API key.
test("the real web app and SDK guest receive live video and audio", async ({ app, browser, screen }) => {
  const invite = process.env.CHALK_E2E_INVITE;
  const directory = process.env.CHALK_E2E_DIRECTORY;
  if (!invite || !directory) throw new Error("Run pnpm web:proof to provision and clean the proof Space");
  const guest = await prepareGuest(directory);
  try {
    await app.open(invite);
    await screen.getByLabel("Your name").fill("Web proof A");
    await screen.getByRole("button", "Enter Space").click();
    await guest.ready;
    const tile = screen.getByLabel("Video tile for Proof guest 1");
    await expect(tile).toBeVisible();
    await expect.poll(() => browser.evaluate(remoteVideoFrames), { timeout: 45_000 }).toBeGreaterThan(5);
    const before = await browser.evaluate(remoteVideoFrames);
    await expect.poll(() => browser.evaluate(remoteVideoFrames), { timeout: 15_000 }).toBeGreaterThan(before + 5);
    await expect.poll(() => browser.evaluate(incomingAudioLevel), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(tile.getByRole("img", "Speaking")).toBeVisible();
    await expect.poll(() => guest.media().then((media) => media.frames), { timeout: 30_000 }).toBeGreaterThan(5);
    const received = await guest.media();
    await expect.poll(() => guest.media().then((media) => media.frames), { timeout: 15_000 }).toBeGreaterThan(received.frames + 5);
    await expect.poll(() => guest.media().then((media) => media.audioLevel), { timeout: 30_000 }).toBeGreaterThan(0);
    await app.screenshot("participant-a");
    await guest.screenshot();
    await screen.getByRole("button", "Leave space").click();
    await screen.getByRole("button", "Leave Space").click();
    await guest.leave();
    await expect(tile).not.toBeVisible();
  } finally {
    await guest.dispose();
  }
});
