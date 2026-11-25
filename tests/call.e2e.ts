import { expect } from "e2e";
import { test } from "@e2e-dev/web";
import { withProofCall } from "../scripts/web-proof/guest.mjs";
import { audioEvidence, incomingAudioLevel, remoteVideoFrames } from "../scripts/web-proof/media.mjs";

async function dragPdf(browser: { evaluate: (script: (drop: boolean) => void, arg: boolean) => Promise<unknown> }, drop: boolean) {
  await browser.evaluate((shouldDrop) => {
    const frame = document.querySelector<HTMLElement>("[data-part=call-frame]");
    if (!frame) throw new Error("The call frame is not mounted");
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["%PDF-1.4\n"], "Algebra worksheet.pdf", { type: "application/pdf" }));
    const dispatch = (type: string) => frame.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    dispatch("dragenter");
    dispatch("dragover");
    if (shouldDrop) dispatch("drop");
  }, drop);
}

// This proof enters by invite and does not check account sign-in. The runner
// creates the Space with the proof Tenant key; the browser never receives it.
test("the real web app and SDK guest receive live video and audio", async ({ app, browser, screen }) => {
  await withProofCall({ app, screen }, async (guest) => {
    const clickControl = async (name: string) => {
      await screen.getByRole("region", "Space stage", { exact: true }).hover();
      await screen.getByRole("button", name, { exact: true }).click();
    };
    await guest.ready;
    await guest.agreement(browser);
    await clickControl("Unmute microphone");
    await guest.agreement(browser);
    await clickControl("Turn on camera");
    await guest.agreement(browser);
    for (const [off, on] of [
      ["Mute microphone", "Unmute microphone"],
      ["Turn off camera", "Turn on camera"],
    ]) {
      await clickControl(off);
      await guest.agreement(browser);
      await clickControl(on);
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

test("a dropped PDF stages in chat with the panel open or closed", async ({ app, browser, screen }) => {
  await withProofCall({ app, screen }, async (guest) => {
    await guest.ready;
    await screen.getByRole("region", "Space stage", { exact: true }).hover();
    await screen.getByRole("button", "Chat", { exact: true }).click();
    await screen.getByRole("complementary", "Chat panel", { exact: true }).waitFor({ state: "visible" });

    await dragPdf(browser, false);
    await expect(screen.getByText("Drop files to send", { exact: true })).toBeVisible();
    await expect(screen.getByText("Up to 5 files, 25 MB each", { exact: true })).toBeVisible();
    await dragPdf(browser, true);
    await expect(screen.getByText("Algebra worksheet.pdf", { exact: true })).toBeVisible();
    await expect(screen.getByRole("region", "Space stage", { exact: true })).toBeVisible();

    await screen.getByRole("button", "Close panel", { exact: true }).click();
    await expect(screen.getByRole("complementary", "Chat panel", { exact: true })).not.toBeVisible();
    await dragPdf(browser, true);
    await screen.getByRole("complementary", "Chat panel", { exact: true }).waitFor({ state: "visible" });
    await expect(screen.getByText("Algebra worksheet.pdf", { exact: true })).toBeVisible();
  });
});
