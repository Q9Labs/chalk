#!/usr/bin/env node
// Drives the "two people in a call" journey: the host starts a call, a second person joins by its link, both turn on microphone
// and camera, and the real-call proofs' checks run on both sides: each sees the other's video advance and hears its audio,
// and every badge, control and playback state agrees (scripts/web-proof/agreement.mjs). Then one mutes and the checks run again.
//
//   node .agents/skills/verify-chalk/scripts/two-person-media.mjs <run-id> [--web <origin>]
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runJourney } from "./journey.mjs";
import { assertAgreement } from "../../../../scripts/web-proof/agreement.mjs";
import { incomingAudioLevel } from "../../../../scripts/web-proof/media.mjs";
import { measureAdvance, measureFirstFrame, receiverTimedOut, senderNeverPublished, videoNotAdvancing } from "../../../../scripts/web-proof/tile-diagnostics.mjs";

const waitMs = 60_000;
const enableMs = 15_000;

await runJourney("two-person-media", async ({ step, person, startCall, joinByLink, control, leave, shot, system, out }) => {
  const host = await person("MediaHost", 1);
  const guest = await person("MediaGuest", 2);
  const both = [host, guest];
  let call;

  await step("the host starts a call and the guest joins by its link", async () => {
    call = await startCall(host);
    await joinByLink(guest, call.link);
    for (const { page } of both) for (const { name } of both) await page.getByRole("button", { name: `Video tile for ${name}`, exact: true }).waitFor({ timeout: 60_000 });
  });

  for (const who of both) {
    await step(`${who.name} turns on microphone and camera`, async () => {
      // Both at once, as a person does: the first publish swaps a connection that never negotiated, and the second enable must survive that.
      await who.page.getByRole("region", { name: "Space stage", exact: true }).hover();
      for (const name of ["Unmute microphone", "Turn on camera"]) await who.page.getByRole("button", { name, exact: true }).click();
      for (const name of ["Mute microphone", "Turn off camera"]) await who.page.getByRole("button", { name, exact: true }).waitFor({ timeout: enableMs });
    });
  }

  for (const who of both) {
    await step(`${who.name} publishes its own video`, async () => {
      const own = await measureFirstFrame(who.page, who.name, { timeoutMs: waitMs });
      if (own.firstFrameMs === null) throw new Error(senderNeverPublished(who.name, own, waitMs));
      return { firstFrameMs: own.firstFrameMs };
    });
  }

  for (const who of both) {
    const other = both.find((entry) => entry !== who);
    await step(`${who.name} sees ${other.name}'s video advance`, async () => {
      const received = await measureFirstFrame(who.page, other.name, { timeoutMs: waitMs });
      if (received.firstFrameMs === null) throw new Error(receiverTimedOut(who.name, other.name, received, waitMs));
      const advance = await measureAdvance(who.page, other.name, { timeoutMs: waitMs });
      if (advance.advancedAfterMs === null) throw new Error(videoNotAdvancing(who.name, other.name, advance, waitMs));
      return { firstFrameMs: received.firstFrameMs, advancedAfterMs: advance.advancedAfterMs };
    });
  }

  await step("both hear each other (incoming audio level above zero on both sides)", async () => {
    for (const { page, name } of both) {
      const deadline = Date.now() + waitMs;
      let level = 0;
      while (level <= 0 && Date.now() < deadline) {
        level = await page.evaluate(incomingAudioLevel);
        if (level <= 0) await page.waitForTimeout(500);
      }
      if (level <= 0) throw new Error(`${name} received no audio within ${waitMs / 1000} s`);
    }
  });

  await step("owner controls, badges and playback agree on both sides", async () => {
    await assertAgreement(
      both.map(({ page }) => page),
      { timeoutMs: 30_000 },
    );
    for (const who of both) await shot(who, "in-call");
  });

  await step("the guest mutes: the host stops hearing them and every badge agrees", async () => {
    await control(guest, "Mute microphone");
    await assertAgreement(
      both.map(({ page }) => page),
      { timeoutMs: 30_000 },
    );
    await control(guest, "Unmute microphone");
    await assertAgreement(
      both.map(({ page }) => page),
      { timeoutMs: 30_000 },
    );
  });

  await step("the API records an Episode with both participants", async () => {
    const episodes = await system("GET", `/v1/tenants/${call.tenantId}/spaces/${call.spaceId}/episodes`);
    const live = (episodes.episodes ?? []).at(0);
    if (!live) throw new Error("the call's Space has no Episode");
    const attendance = await system("GET", `/v1/tenants/${call.tenantId}/spaces/${call.spaceId}/episodes/${live.id}/attendance`);
    await writeFile(join(out, "attendance.json"), `${JSON.stringify(attendance, null, 2)}\n`);
    const names = JSON.stringify(attendance);
    for (const { name } of both) if (!names.includes(name)) throw new Error(`attendance does not list ${name}`);
    return { episode: live.id };
  });

  await step("both leave", async () => {
    for (const who of both) {
      await leave(who);
    }
  });
});
