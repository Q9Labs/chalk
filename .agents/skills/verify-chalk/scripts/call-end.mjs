#!/usr/bin/env node
// Drives the end of a call for every Participant: the host starts a call, two guests join by its link (one with camera and
// microphone off, as a class often has), the Episode's deadline moves to a few seconds away, and the Episode reaches its
// time limit while all three are in it. Each Participant must see "The call reached its time limit" and never see
// "Reconnecting" or "Connection lost".
//
//   node .agents/skills/verify-chalk/scripts/call-end.mjs <run-id> [--web <origin>]
import { randomUUID } from "node:crypto";
import { runJourney } from "./journey.mjs";

const wait = 60_000;
// A deadline cannot sit within a minute of the start, and the server ends the call on its own schedule.
const endWait = 120_000;

await runJourney("call-end", async ({ step, person, startCall, joinByLink, shot, system, seed, web, people }) => {
  const host = await person("EndHost", 1);
  const quiet = await person("EndGuestQuiet", 2);
  const loud = await person("EndGuestLoud", 3);
  let call;
  let episode;

  await step("the host starts a call and two guests join by its link", async () => {
    call = await startCall(host);
    await joinByLink(quiet, call.link);
    await joinByLink(loud, call.link);
    for (const { page } of people) for (const { name } of people) await page.getByRole("button", { name: `Video tile for ${name}`, exact: true }).waitFor({ timeout: wait });
    for (const who of [host, loud]) {
      await who.page.getByRole("region", { name: "Space stage", exact: true }).hover();
      for (const name of ["Unmute microphone", "Turn on camera"]) await who.page.getByRole("button", { name, exact: true }).click();
    }
  });

  await step("the Episode reaches its time limit while all three are in it", async () => {
    const { episodes } = await system("GET", `/v1/tenants/${call.tenantId}/spaces/${call.spaceId}/episodes`);
    episode = episodes.at(0);
    if (!episode) throw new Error("the Space has no Episode");
    const at = Math.max(Date.now() + 15_000, Date.parse(episode.created_at) + 62_000);
    const response = await fetch(new URL(`/v1/tenants/${call.tenantId}/spaces/${call.spaceId}/episodes/${episode.id}/deadline`, web), {
      method: "POST",
      headers: { Authorization: `Bearer ${seed.systemToken}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ deadline_at: new Date(at).toISOString() }),
    });
    if (!response.ok) throw new Error(`set deadline answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  });

  const seen = new Map(people.map((who) => [who.name, new Set()]));
  const ended = people.map((who) =>
    (async () => {
      const heading = who.page.getByRole("heading", { name: "The call reached its time limit", exact: true });
      const deadline = Date.now() + endWait;
      while (Date.now() < deadline) {
        for (const text of ["Reconnecting", "Connection lost"]) if (await who.page.getByText(text, { exact: false }).first().isVisible().catch(() => false)) seen.get(who.name).add(text);
        if (await heading.isVisible().catch(() => false)) return true;
        await who.page.waitForTimeout(250);
      }
      return false;
    })(),
  );
  const results = await Promise.all(ended);

  for (const [index, who] of people.entries()) {
    await step(`${who.name} sees that the call has ended`, async () => {
      await shot(who, "time-limit-ended");
      if (!results[index]) throw new Error(`${who.name} never saw "The call reached its time limit"; saw ${[...seen.get(who.name)].join(", ") || "nothing else"}`);
      if (seen.get(who.name).size) throw new Error(`${who.name} saw ${[...seen.get(who.name)].join(" and ")} before the ended screen`);
    });
  }

  await step("the Episode is ended with reason maximum_duration", async () => {
    const { episodes } = await system("GET", `/v1/tenants/${call.tenantId}/spaces/${call.spaceId}/episodes`);
    const final = episodes.find((item) => item.id === episode.id);
    if (final?.status !== "ended" || final.end_reason !== "maximum_duration") throw new Error(`Episode is ${JSON.stringify({ status: final?.status, end_reason: final?.end_reason })}`);
  });
});
