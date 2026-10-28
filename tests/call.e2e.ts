import { expect } from "e2e";
import { test } from "@e2e-dev/web";
import { withProofCall } from "../scripts/web-proof/guest.mjs";
import { audioEvidence, incomingAudioLevel, remoteVideoFrames } from "../scripts/web-proof/media.mjs";

// This proof enters by invite and does not check account sign-in. The runner
// creates the Space with the proof Tenant key; the browser never receives it.
test("the real web app and SDK guest receive live video and audio", async ({ app, browser, screen }) => {
  await withProofCall({ app, screen }, async (guest) => {
    await screen.getByRole("button", "Unmute microphone", { exact: true }).click();
    await screen.getByRole("button", "Turn on camera", { exact: true }).click();
    await guest.ready;
    await guest.agreement(browser);
    for (const [off, on] of [
      ["Mute microphone", "Unmute microphone"],
      ["Turn off camera", "Turn on camera"],
    ]) {
      await screen.getByRole("button", off, { exact: true }).click();
      await guest.agreement(browser);
      await screen.getByRole("button", on, { exact: true }).click();
      await guest.agreement(browser);
    }
    const tile = screen.getByLabel("Video tile for Proof guest 1");
    await expect(tile).toBeVisible();
    await expect.poll(() => browser.evaluate(remoteVideoFrames), { timeout: 45_000 }).toBeGreaterThan(5);
    const before = await browser.evaluate(remoteVideoFrames);
    await expect.poll(() => browser.evaluate(remoteVideoFrames), { timeout: 15_000 }).toBeGreaterThan(before + 5);
    await expect.poll(() => browser.evaluate(incomingAudioLevel), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(() => guest.media().then((media) => media.frames), { timeout: 30_000 }).toBeGreaterThan(5);
    const received = await guest.media();
    await expect.poll(() => guest.media().then((media) => media.frames), { timeout: 15_000 }).toBeGreaterThan(received.frames + 5);
    await guest.playAudio();
    await app.screenshot("participant-a");
    await guest.screenshot();
    await expect.poll(() => guest.media().then((media) => media.audioLevel), { timeout: 30_000 }).toBeGreaterThan(0);
    await guest.evidence(await browser.evaluate(audioEvidence));
    await screen.getByRole("region", "Space stage", { exact: true }).hover();
    await screen.getByRole("button", "Leave call", { exact: true }).click();
    await guest.leave();
    await expect(tile).not.toBeVisible();
  });
});
