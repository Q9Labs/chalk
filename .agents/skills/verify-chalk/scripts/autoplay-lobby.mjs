#!/usr/bin/env node
// Proves autoplay-aware entry: a returning visitor whose browser blocks sound gets the one-click lobby;
// Join is the gesture that makes remote audio audible. A browser that already allows sound still auto-joins.
import { runJourney } from "./journey.mjs";
import { incomingAudioLevel } from "../../../../scripts/web-proof/media.mjs";

const waitMs = 30_000;
const pollMs = 250;
const remembered = (name, theme) => `(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => false });
  localStorage.setItem("chalk.display-name", ${JSON.stringify(name)});
  localStorage.setItem("chalk.prejoin-devices", JSON.stringify({ microphone: false, camera: false }));
  document.cookie = "chalk_theme=${theme}; path=/";
})()`;

async function noGesture(page, expression) {
  const cdp = await page.context().newCDPSession(page);
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, userGesture: false });
  await cdp.detach().catch(() => undefined);
  if (result.exceptionDetails) throw new Error(`strict page evaluation failed: ${result.exceptionDetails.text}`);
  return result.result.value;
}

async function waitForNoGesture(page, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await noGesture(page, expression)) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

const lobbyEvidence = `(() => {
  const input = document.querySelector("#join-display-name");
  const button = [...document.querySelectorAll("button")].find((element) => element.textContent === "Join call");
  const box = button?.getBoundingClientRect();
  return { input: input?.value ?? null, joining: Boolean(button), tile: Boolean(document.querySelector('[aria-label^="Video tile for "]')), x: box ? box.x + box.width / 2 : null, y: box ? box.y + box.height / 2 : null, active: navigator.userActivation.hasBeenActive };
})()`;
const rejoinLobbyEvidence = lobbyEvidence.replaceAll('"Join call"', '"Rejoin"');

await runJourney("autoplay-lobby", async ({ step, person, startCall, control, shot, system }) => {
  const host = await person("AutoplayHost", 1, { permission: "granted" });
  const strict = await person("StrictGuest", 2, { permission: "granted", autoplayPolicy: "document-user-activation-required", initScript: remembered("StrictGuest", "dark") });
  const strictMobile = await person("StrictMobile", 3, { device: "android", permission: "granted", autoplayPolicy: "document-user-activation-required", initScript: remembered("StrictMobile", "light") });
  const strictDesktopLight = await person("StrictLight", 5, { permission: "granted", autoplayPolicy: "document-user-activation-required", initScript: remembered("StrictLight", "light") });
  const strictMobileDark = await person("StrictDarkMobile", 6, { device: "android", permission: "granted", autoplayPolicy: "document-user-activation-required", initScript: remembered("StrictDarkMobile", "dark") });
  const allowed = await person("AllowedGuest", 4, { permission: "granted", initScript: remembered("AllowedGuest", "dark") });
  let link;
  let ids;

  await step("the host starts a call and publishes tone audio", async () => {
    const call = await startCall(host);
    link = call.link;
    ids = call;
    await system("PATCH", `/v1/tenants/${call.tenantId}/spaces/${call.spaceId}`, { admission_policy: { mode: "knock" } });
    await control(host, "Unmute microphone");
    await host.page.getByRole("button", { name: "Mute microphone", exact: true }).waitFor({ timeout: 15_000 });
  });

  for (const [who, label] of [
    [strict, "desktop-dark"],
    [strictMobile, "mobile-light"],
    [strictDesktopLight, "desktop-light"],
    [strictMobileDark, "mobile-dark"],
  ]) {
    await step(`${who.name} with remembered devices and no gesture is offered the lobby`, async () => {
      await who.page.goto(link);
      await waitForNoGesture(who.page, `Boolean(document.querySelector("#join-display-name"))`, 15_000, `${who.name} lobby`);
      const evidence = await noGesture(who.page, lobbyEvidence);
      if (evidence.input !== who.name) throw new Error(`remembered name was not filled for ${who.name}: ${evidence.input}`);
      if (!evidence.joining) throw new Error(`${who.name} did not get the Join call lobby`);
      if (evidence.tile) throw new Error(`${who.name} auto-joined despite blocked autoplay`);
      if (evidence.active) throw new Error(`${who.name} already had browser activation before Join`);
      who.joinPoint = evidence;
      await shot(who, `lobby-${label}`);
    });
  }

  await step("one Join click enters the strict guest and makes the host audible with no fallback toast", async () => {
    await strict.page.mouse.click(strict.joinPoint.x, strict.joinPoint.y);
    await strict.page.getByText(/^Asking to join/).waitFor({ timeout: 60_000 });
    await host.page.getByRole("button", { name: `Let ${strict.name} in`, exact: true }).click();
    await strict.page.getByRole("button", { name: `Video tile for ${strict.name}`, exact: true }).waitFor({ timeout: 60_000 });
    await system("PATCH", `/v1/tenants/${ids.tenantId}/spaces/${ids.spaceId}`, { admission_policy: { mode: "open" } });
    const deadline = Date.now() + waitMs;
    let level = 0;
    while (level <= 0 && Date.now() < deadline) {
      level = await strict.page.evaluate(incomingAudioLevel);
      if (level <= 0) await strict.page.waitForTimeout(250);
    }
    if (level <= 0) throw new Error("Join click did not produce audible remote audio");
    const toast = strict.page.locator('[data-part="toast"]', { hasText: "Your browser paused the sound. Click anywhere to hear the class." });
    if ((await toast.count()) !== 0) throw new Error("fallback toast appeared after Join enabled sound");
    return { audioLevel: level };
  });

  await step("a returning visitor whose browser allows autoplay still auto-joins without the lobby", async () => {
    await allowed.page.goto(link);
    await allowed.page.getByRole("button", { name: `Video tile for ${allowed.name}`, exact: true }).waitFor({ timeout: 60_000 });
    if (
      await allowed.page
        .getByLabel("Your name", { exact: true })
        .isVisible()
        .catch(() => false)
    )
      throw new Error("autoplay-capable returning visitor saw the lobby");
  });

  await step("a reloaded strict guest gets the lobby and rejoins the knock-protected call without a second approval", async () => {
    await system("PATCH", `/v1/tenants/${ids.tenantId}/spaces/${ids.spaceId}`, { admission_policy: { mode: "knock" } });
    await strict.page.reload();
    await waitForNoGesture(strict.page, `Boolean(document.querySelector("#join-display-name"))`, 15_000, "strict reload lobby");
    const evidence = await noGesture(strict.page, rejoinLobbyEvidence);
    if (evidence.input !== strict.name || !evidence.joining || evidence.tile || evidence.active) throw new Error(`strict reload did not produce the untouched lobby: ${JSON.stringify(evidence)}`);
    if (!(await noGesture(strict.page, `document.body.textContent.includes("Rejoin the call")`))) throw new Error("reload lobby did not use the rejoin wording");
    await strict.page.mouse.click(evidence.x, evidence.y);
    await strict.page.getByRole("button", { name: `Video tile for ${strict.name}`, exact: true }).waitFor({ timeout: 60_000 });
    if (
      await strict.page
        .getByText(/^Asking to join/)
        .isVisible()
        .catch(() => false)
    )
      throw new Error("reloaded guest was asked to knock again");
    if ((await host.page.getByRole("button", { name: `Let ${strict.name} in`, exact: true }).count()) !== 0) throw new Error("host received a second approval request after reload");
    const deadline = Date.now() + waitMs;
    let level = 0;
    while (level <= 0 && Date.now() < deadline) {
      level = await strict.page.evaluate(incomingAudioLevel);
      if (level <= 0) await strict.page.waitForTimeout(pollMs);
    }
    if (level <= 0) throw new Error("reloaded Join click did not restore audible remote audio");
    await system("PATCH", `/v1/tenants/${ids.tenantId}/spaces/${ids.spaceId}`, { admission_policy: { mode: "open" } });
    return { audioLevel: level };
  });

  await step("a reloaded autoplay-capable guest resumes directly without the lobby", async () => {
    await allowed.page.reload();
    await allowed.page.getByRole("button", { name: `Video tile for ${allowed.name}`, exact: true }).waitFor({ timeout: 60_000 });
    if (
      await allowed.page
        .getByLabel("Your name", { exact: true })
        .isVisible()
        .catch(() => false)
    )
      throw new Error("autoplay-capable reload showed the lobby");
  });

  await step("the second strict visitor can join through the same lobby", async () => {
    await strictMobile.page.touchscreen.tap(strictMobile.joinPoint.x, strictMobile.joinPoint.y);
    await strictMobile.page.getByRole("button", { name: `Video tile for ${strictMobile.name}`, exact: true }).waitFor({ timeout: 60_000 });
  });
});
