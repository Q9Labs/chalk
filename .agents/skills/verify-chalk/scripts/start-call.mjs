#!/usr/bin/env node
// Drives the "start a call" journey, the way a person does it: they open /space/, enter a name and start a call, a second person
// joins by the call's link, both turn on camera and microphone and see each other. The starter leaves and presses Rejoin, still has
// the owner menu, and ends the call for everyone, and the second person is told it ended.
//
//   node .agents/skills/verify-chalk/scripts/start-call.mjs <run-id> [--web <origin>]
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runJourney } from "./journey.mjs";
import { incomingAudioLevel } from "../../../../scripts/web-proof/media.mjs";
import { measureAdvance, measureFirstFrame, receiverTimedOut, senderNeverPublished, videoNotAdvancing } from "../../../../scripts/web-proof/tile-diagnostics.mjs";

const waitMs = 60_000;
const enableMs = 15_000;

await runJourney("start-call", async ({ step, person, startCall, joinByLink, control, shot, system, out }) => {
  const starter = await person("StartCaller", 1);
  const guest = await person("StartGuest", 2);
  const both = [starter, guest];
  const tile = (who, name) => who.page.getByRole("button", { name: `Video tile for ${name}`, exact: true });
  let call;

  await step("the starter starts a call and the guest joins by its link", async () => {
    call = await startCall(starter);
    await joinByLink(guest, call.link);
    for (const { page } of both) for (const { name } of both) await page.getByRole("button", { name: `Video tile for ${name}`, exact: true }).waitFor({ timeout: waitMs });
  });

  for (const who of both) {
    await step(`${who.name} turns on microphone and camera`, async () => {
      await who.page.getByRole("region", { name: "Space stage", exact: true }).hover();
      for (const name of ["Unmute microphone", "Turn on camera"]) await who.page.getByRole("button", { name, exact: true }).click();
      for (const name of ["Mute microphone", "Turn off camera"]) await who.page.getByRole("button", { name, exact: true }).waitFor({ timeout: enableMs });
    });
  }

  for (const who of both) {
    await step(`${who.name} publishes its own video`, async () => {
      const own = await measureFirstFrame(who.page, who.name, { timeoutMs: waitMs });
      if (own.firstFrameMs === null) throw new Error(senderNeverPublished(who.name, own, waitMs));
    });
  }

  for (const who of both) {
    const other = both.find((entry) => entry !== who);
    await step(`${who.name} sees ${other.name}'s video advance`, async () => {
      const received = await measureFirstFrame(who.page, other.name, { timeoutMs: waitMs });
      if (received.firstFrameMs === null) throw new Error(receiverTimedOut(who.name, other.name, received, waitMs));
      const advance = await measureAdvance(who.page, other.name, { timeoutMs: waitMs });
      if (advance.advancedAfterMs === null) throw new Error(videoNotAdvancing(who.name, other.name, advance, waitMs));
    });
  }

  await step("both hear each other", async () => {
    for (const { page, name } of both) {
      const deadline = Date.now() + waitMs;
      let level = 0;
      while (level <= 0 && Date.now() < deadline) {
        level = await page.evaluate(incomingAudioLevel);
        if (level <= 0) await page.waitForTimeout(500);
      }
      if (level <= 0) throw new Error(`${name} received no audio within ${waitMs / 1000} s`);
    }
    for (const who of both) await shot(who, "in-call");
  });

  await step("the starter has the owner menu", async () => {
    await control(starter, "Leave call");
    await starter.page.getByRole("menuitem", { name: "End call for everyone", exact: true }).waitFor({ timeout: 10_000 });
    await shot(starter, "owner-menu");
    await starter.page.keyboard.press("Escape");
  });

  await step("the starter leaves and the guest stays in the call", async () => {
    await control(starter, "Leave call");
    await starter.page.getByRole("menuitem", { name: "Leave call", exact: true }).click();
    await starter.page.getByRole("button", { name: "Rejoin", exact: true }).waitFor({ timeout: 30_000 });
    await shot(starter, "left");
    await tile(guest, guest.name).waitFor({ timeout: 10_000 });
  });

  await step("the starter rejoins and the guest sees them again", async () => {
    await starter.page.getByRole("button", { name: "Rejoin", exact: true }).click();
    await tile(starter, starter.name).waitFor({ timeout: waitMs });
    await tile(guest, starter.name).waitFor({ timeout: waitMs });
    await shot(starter, "rejoined");
  });

  await step("the rejoined starter still has the owner menu", async () => {
    await control(starter, "Leave call");
    await starter.page.getByRole("menuitem", { name: "End call for everyone", exact: true }).waitFor({ timeout: 10_000 });
    await shot(starter, "owner-menu-after-rejoin");
    await starter.page.keyboard.press("Escape");
  });

  await step("the guest has no owner menu: Leave call leaves at once, and Rejoin brings them back", async () => {
    await control(guest, "Leave call");
    await guest.page.getByRole("button", { name: "Rejoin", exact: true }).waitFor({ timeout: 30_000 });
    await guest.page.getByRole("button", { name: "Rejoin", exact: true }).click();
    await tile(guest, guest.name).waitFor({ timeout: waitMs });
    await tile(starter, guest.name).waitFor({ timeout: waitMs });
  });

  await step("the API lists both people in the call's attendance", async () => {
    const episodes = await system("GET", `/v1/tenants/${call.tenantId}/spaces/${call.spaceId}/episodes`);
    const live = (episodes.episodes ?? []).at(0);
    if (!live) throw new Error("the call's Space has no Episode");
    const attendance = await system("GET", `/v1/tenants/${call.tenantId}/spaces/${call.spaceId}/episodes/${live.id}/attendance`);
    await writeFile(join(out, "attendance.json"), `${JSON.stringify(attendance, null, 2)}\n`);
    for (const { name } of both) if (!JSON.stringify(attendance).includes(name)) throw new Error(`attendance does not list ${name}`);
  });

  await step("the starter ends the call for everyone and both are told", async () => {
    await control(starter, "Leave call");
    await starter.page.getByRole("menuitem", { name: "End call for everyone", exact: true }).click();
    for (const who of both) await who.page.getByRole("heading", { name: "The call ended", exact: true }).waitFor({ timeout: 30_000 });
    await shot(guest, "ended");
  });
});
