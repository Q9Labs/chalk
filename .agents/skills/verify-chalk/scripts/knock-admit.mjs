#!/usr/bin/env node
// Drives the "ask to join" journey: the host starts a call and sets it to ask first. One person knocks and waits, the host sees
// the request and lets them in, and both are in the call. A second person knocks, the host declines, and that person is told so.
//
//   node .agents/skills/verify-chalk/scripts/knock-admit.mjs <run-id> [--web <origin>]
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runJourney } from "./journey.mjs";

await runJourney("knock-admit", async ({ step, person, startCall, enterLink, leave, shot, system, out }) => {
  const host = await person("KnockHost", 1);
  const guest = await person("KnockGuest", 2);
  const refused = await person("KnockRefused", 3);
  let call;

  await step("the host starts a call and sets it to ask first", async () => {
    call = await startCall(host);
    // A Space's admission mode is read when someone arrives; the web app has no in-call switch for it, so the API sets it.
    await system("PATCH", `/v1/tenants/${call.tenantId}/spaces/${call.spaceId}`, { admission_policy: { mode: "knock" } });
  });

  await step("a person who opens the link waits for the host instead of joining", async () => {
    await enterLink(guest, call.link);
    await guest.page.getByText(/^Asking to join/).waitFor({ timeout: 60_000 });
    if ((await guest.page.getByRole("button", { name: `Video tile for ${guest.name}`, exact: true }).count()) > 0) throw new Error("the knocking guest got a tile before the host let them in");
    await shot(guest, "waiting");
  });

  await step("the host sees the request and lets them in", async () => {
    await host.page.getByText(guest.name, { exact: true }).first().waitFor({ timeout: 60_000 });
    await shot(host, "request");
    await host.page.getByRole("button", { name: `Let ${guest.name} in`, exact: true }).click();
    for (const { page } of [host, guest]) for (const { name } of [host, guest]) await page.getByRole("button", { name: `Video tile for ${name}`, exact: true }).waitFor({ timeout: 60_000 });
    await shot(guest, "admitted");
  });

  await step("the API lists the admitted guest in attendance", async () => {
    const episodes = await system("GET", `/v1/tenants/${call.tenantId}/spaces/${call.spaceId}/episodes`);
    const live = (episodes.episodes ?? []).at(0);
    if (!live) throw new Error("the call's Space has no Episode");
    const attendance = await system("GET", `/v1/tenants/${call.tenantId}/spaces/${call.spaceId}/episodes/${live.id}/attendance`);
    await writeFile(join(out, "attendance.json"), `${JSON.stringify(attendance, null, 2)}\n`);
    if (!JSON.stringify(attendance).includes(guest.name)) throw new Error(`attendance does not list ${guest.name}`);
  });

  await step("a second person knocks, the host declines, and they are told", async () => {
    await enterLink(refused, call.link);
    await refused.page.getByText(/^Asking to join/).waitFor({ timeout: 60_000 });
    await host.page.getByRole("button", { name: `Decline ${refused.name}`, exact: true }).click();
    await refused.page.getByText("The host declined your request to join.").waitFor({ timeout: 60_000 });
    await shot(refused, "declined");
  });

  await step("both leave", async () => {
    for (const who of [host, guest]) {
      await leave(who);
    }
  });
});
