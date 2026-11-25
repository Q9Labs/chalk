#!/usr/bin/env node
// Proves autoplay-aware entry: a returning visitor whose browser blocks sound gets the one-click lobby;
// Join is the gesture that makes remote audio audible. A browser that already allows sound still auto-joins.
import { runJourney } from "./journey.mjs";
import { incomingAudioLevel } from "../../../../scripts/web-proof/media.mjs";

const waitMs = 30_000;
const remembered = (name, theme) => `(() => {
  localStorage.setItem("chalk.display-name", ${JSON.stringify(name)});
  localStorage.setItem("chalk.prejoin-devices", JSON.stringify({ microphone: false, camera: false }));
  document.cookie = "chalk_theme=${theme}; path=/";
})()`;

await runJourney("autoplay-lobby", async ({ step, person, startCall, control, shot }) => {
  const host = await person("AutoplayHost", 1, { permission: "granted" });
  const strict = await person("StrictGuest", 2, { permission: "granted", autoplayPolicy: "document-user-activation-required", initScript: remembered("StrictGuest", "dark") });
  const strictMobile = await person("StrictMobile", 3, { device: "android", permission: "granted", autoplayPolicy: "document-user-activation-required", initScript: remembered("StrictMobile", "light") });
  const strictDesktopLight = await person("StrictLight", 5, { permission: "granted", autoplayPolicy: "document-user-activation-required", initScript: remembered("StrictLight", "light") });
  const strictMobileDark = await person("StrictDarkMobile", 6, { device: "android", permission: "granted", autoplayPolicy: "document-user-activation-required", initScript: remembered("StrictDarkMobile", "dark") });
  const allowed = await person("AllowedGuest", 4, { permission: "granted", initScript: remembered("AllowedGuest", "dark") });
  let link;

  await step("the host starts a call and publishes tone audio", async () => {
    const call = await startCall(host);
    link = call.link;
    await control(host, "Unmute microphone");
    await host.page.getByRole("button", { name: "Mute microphone", exact: true }).waitFor({ timeout: 15_000 });
  });

  for (const [who, label] of [[strict, "desktop-dark"], [strictMobile, "mobile-light"], [strictDesktopLight, "desktop-light"], [strictMobileDark, "mobile-dark"]]) {
    await step(`${who.name} with remembered devices and no gesture is offered the lobby`, async () => {
      await who.page.goto(link);
      const input = who.page.getByLabel("Your name", { exact: true });
      await input.waitFor({ timeout: 15_000 });
      if ((await input.inputValue()) !== who.name) throw new Error(`remembered name was not filled for ${who.name}`);
      await who.page.getByRole("button", { name: "Join call", exact: true }).waitFor({ timeout: 15_000 });
      if (await who.page.getByRole("button", { name: `Video tile for ${who.name}`, exact: true }).isVisible().catch(() => false)) throw new Error(`${who.name} auto-joined despite blocked autoplay`);
      await shot(who, `lobby-${label}`);
    });
  }

  await step("one Join click enters the strict guest and makes the host audible with no fallback toast", async () => {
    await strict.page.getByRole("button", { name: "Join call", exact: true }).click();
    await strict.page.getByRole("button", { name: `Video tile for ${strict.name}`, exact: true }).waitFor({ timeout: 60_000 });
    const deadline = Date.now() + waitMs;
    let level = 0;
    while (level <= 0 && Date.now() < deadline) {
      level = await strict.page.evaluate(incomingAudioLevel);
      if (level <= 0) await strict.page.waitForTimeout(250);
    }
    if (level <= 0) throw new Error("Join click did not produce audible remote audio");
    const toast = strict.page.getByText("Your browser paused the sound. Click anywhere to hear the class.", { exact: true });
    if (await toast.isVisible().catch(() => false)) throw new Error("fallback toast appeared after Join enabled sound");
    return { audioLevel: level };
  });

  await step("a returning visitor whose browser allows autoplay still auto-joins without the lobby", async () => {
    await allowed.page.goto(link);
    await allowed.page.getByRole("button", { name: `Video tile for ${allowed.name}`, exact: true }).waitFor({ timeout: 60_000 });
    if (await allowed.page.getByLabel("Your name", { exact: true }).isVisible().catch(() => false)) throw new Error("autoplay-capable returning visitor saw the lobby");
  });

  await step("the second strict visitor can join through the same lobby", async () => {
    await strictMobile.page.getByRole("button", { name: "Join call", exact: true }).click();
    await strictMobile.page.getByRole("button", { name: `Video tile for ${strictMobile.name}`, exact: true }).waitFor({ timeout: 60_000 });
  });
});
