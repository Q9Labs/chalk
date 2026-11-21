import assert from "node:assert/strict";
import { runJourney } from "./journey.mjs";

const warning = "No input from your microphone.";
const chooser = { name: "Choose microphone", exact: true };

await runJourney("silent-microphone", async ({ web, person, step, startCall, control, shot }) => {
  const origin = new URL(web);
  assert.ok(origin.hostname === "localhost" || origin.hostname === "127.0.0.1" || origin.hostname.endsWith(".instabox.tech"), "Use a non-production Chalk stack");
  const guest = await person("Mic Check", 1);
  const { page } = guest;
  await guest.context.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const devices = navigator.mediaDevices;
      const capture = devices.getUserMedia.bind(devices);
      const enumerate = devices.enumerateDevices.bind(devices);
      devices.enumerateDevices = async () => [{ deviceId: "silent-mic", kind: "audioinput", label: "Silent microphone" }, { deviceId: "quiet-mic", kind: "audioinput", label: "Quiet microphone" }, ...(await enumerate()).filter((device) => device.kind !== "audioinput")];
      devices.getUserMedia = async (constraints) => {
        if (!constraints.audio) return capture(constraints);
        const stream = await capture(constraints);
        for (const original of stream.getAudioTracks()) {
          stream.removeTrack(original);
          original.stop();
        }
        const deviceId = constraints.audio.deviceId?.exact ?? "silent-mic";
        const audio = new AudioContext();
        const destination = audio.createMediaStreamDestination();
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        gain.gain.value = deviceId === "quiet-mic" ? 0.08 : 0;
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        const [track] = destination.stream.getAudioTracks();
        const settings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...settings(), deviceId });
        window.setMicGain = (value) => {
          gain.gain.value = value;
        };
        stream.addTrack(track);
        return stream;
      };
    });
  });
  const notice = page.locator("[data-part=toast]").filter({ hasText: warning });
  const meter = page.getByRole("meter", { name: "Microphone level" });

  await step("the pre-join meter shows silence and responds to input", async () => {
    await page.goto(new URL("/space/", web).href);
    await page.getByRole("button", { name: "Turn on microphone", exact: true }).click();
    const allow = page.getByRole("button", { name: "Turn on", exact: true });
    if (await allow.isVisible()) await allow.click();
    await meter.waitFor();
    assert.equal(await meter.getAttribute("aria-valuenow"), "0");
    await shot(guest, "prejoin-no-input");
    await page.evaluate(() => window.setMicGain(0.08));
    await page.waitForFunction(() => Number(document.querySelector('[role="meter"][aria-label="Microphone level"]')?.getAttribute("aria-valuenow")) > 0);
    await shot(guest, "prejoin-input");
  });

  await step("an in-call silent mic shows a notice with an action", async () => {
    await startCall(guest);
    const unmute = page.getByRole("button", { name: "Unmute microphone", exact: true });
    if (await unmute.isVisible()) await control(guest, "Unmute microphone");
    await page.getByRole("button", { name: "Mute microphone", exact: true }).waitFor();
    await notice.waitFor({ timeout: 18_000 });
    await shot(guest, "call-no-input");
  });

  await step("the notice opens the picker and quiet input clears the notice", async () => {
    const action = notice.getByRole("button", chooser);
    await action.focus();
    await page.keyboard.press("Enter");
    const picker = page.getByRole("dialog", { name: "Audio" });
    await picker.getByRole("radio", { name: "Quiet microphone", checked: false }).click();
    await picker.getByRole("radio", { name: "Quiet microphone", checked: true }).waitFor();
    await shot(guest, "call-pick-mic");
    await page.keyboard.press("Escape");
    await notice.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Mute microphone", exact: true }).waitFor();
    // Nonzero input well below the meter's first visible bar is not a dead input.
    await page.evaluate(() => window.setMicGain(0.001));
    await page.waitForTimeout(13_000);
    assert.equal(await notice.count(), 0);
    await shot(guest, "call-input-restored");
  });

  await step("a muted microphone does not show a notice", async () => {
    await control(guest, "Mute microphone");
    await page.getByRole("button", { name: "Unmute microphone", exact: true }).waitFor();
    await page.waitForTimeout(13_000);
    assert.equal(await notice.count(), 0);
  });
});
