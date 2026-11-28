#!/usr/bin/env node
// Drives Focus: Focus is turned on for the seeded Space and two people join by its invite. A guest steps out of the window and the viewer sees "Not focused",
// the guest comes back, steps away with a reason and returns, and the viewer allows other tabs so leaving the window shows "Allowed".
//
//   node .agents/skills/verify-chalk/scripts/focus-attention.mjs <run-id> [--web <origin>]
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runJourney } from "./journey.mjs";

const wait = 60_000;
const databaseUrl = process.env.CHALK_DEV_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/chalk_dev";

// The browser reads `document.visibilityState` and `hasFocus()`; a headless page never loses either, so the guest's window is moved away by
// answering those two reads and sending the events a real window switch sends.
const setWindow = (who, away) =>
  who.page.evaluate((hidden) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.hasFocus = () => !hidden;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event(hidden ? "blur" : "focus"));
  }, away);

await runJourney("focus-attention", async ({ step, person, seed, web, joinByLink, shot, system, out }) => {
  const viewer = await person("FocusViewer", 1);
  const guest = await person("FocusGuest", 2);

  await step("Focus is turned on for the Space and both people join by its invite link", async () => {
    // Focus is a Space setting that an Episode copies when it starts, and the web app has no switch for it, so the API turns it on before anyone arrives.
    // The invite gives the collaborator role, which has no Focus capability; the viewer needs focus.view, so the seeded Space's role gets it.
    await system("PATCH", `/v1/tenants/${seed.tenantId}/spaces/${seed.spaceId}`, { focus: { enabled: true } });
    execFileSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-c", `update space_roles set capabilities = capabilities || array['focus.view', 'focus.manage'] where space_id = '${seed.spaceId}' and name = 'collaborator' and not capabilities @> array['focus.view']`]);
    const link = new URL(seed.invite.path, web).href;
    await joinByLink(viewer, link);
    await joinByLink(guest, link);
    for (const { page } of [viewer, guest]) for (const { name } of [viewer, guest]) await page.getByRole("button", { name: `Video tile for ${name}`, exact: true }).waitFor({ timeout: wait });
    for (const who of [viewer, guest]) {
      await who.page.getByRole("dialog").getByText("Focus is on", { exact: true }).waitFor({ timeout: wait });
      if (who === guest) await shot(guest, "notice");
      await who.page.getByRole("button", { name: "Got it", exact: true }).click();
      await who.page.getByRole("status", { name: "Focus on. Focused", exact: true }).waitFor({ timeout: wait });
    }
    await shot(guest, "focused");
  });

  await step("the viewer sees Not focused when the guest leaves the window, and it clears when they return", async () => {
    await setWindow(guest, true);
    await guest.page.getByRole("status", { name: "Focus on. Not focused", exact: true }).waitFor({ timeout: wait });
    await viewer.page.getByText(/^Not focused \d+:\d\d$/).waitFor({ timeout: wait });
    await shot(viewer, "not-focused");
    await setWindow(guest, false);
    await viewer.page.getByText(/^Not focused/).waitFor({ state: "detached", timeout: wait });
    await guest.page.getByRole("status", { name: "Focus on. Focused", exact: true }).waitFor({ timeout: wait });
  });

  await step("the guest steps away with a reason and the viewer sees it until they are back", async () => {
    await guest.page.getByRole("button", { name: `Video tile for ${guest.name}`, exact: true }).hover();
    await guest.page.getByRole("button", { name: `More options for ${guest.name}`, exact: true }).click();
    await guest.page.getByRole("menuitem", { name: "Step away · Reading", exact: true }).click();
    await viewer.page.getByText("Stepped away · Reading", { exact: true }).waitFor({ timeout: wait });
    await shot(viewer, "stepped-away");
    await guest.page.getByRole("button", { name: `Video tile for ${guest.name}`, exact: true }).hover();
    await guest.page.getByRole("button", { name: `More options for ${guest.name}`, exact: true }).click();
    await guest.page.getByRole("menuitem", { name: "I’m back", exact: true }).click();
    await viewer.page.getByText(/^Stepped away/).waitFor({ state: "detached", timeout: wait });
  });

  await step("the viewer allows other tabs and the guest leaving the window shows Allowed", async () => {
    await viewer.page.getByRole("button", { name: "Call details", exact: true }).click();
    await viewer.page.getByRole("button", { name: /^Allow other tabs/ }).click();
    await viewer.page.getByRole("button", { name: "5 min", exact: true }).click();
    await viewer.page.getByText("Other tabs are allowed", { exact: true }).waitFor({ timeout: wait });
    await viewer.page.getByText(/^[0-5]:\d\d left$/).waitFor({ timeout: wait });
    const font = await viewer.page.evaluate(() => ({
      computed: getComputedStyle(document.querySelector(".chalk-shell-detail-label") ?? document.body).fontFamily,
      loaded: [...document.fonts].filter((face) => face.status === "loaded" && /figtree/i.test(face.family)).length,
    }));
    if (!/figtree/i.test(font.computed) || font.loaded === 0) throw new Error(`the call menu is not rendering in Chalk's font: ${JSON.stringify(font)}`);
    await shot(viewer, "allowance");
    await viewer.page.getByRole("dialog", { name: "Call details", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
    await setWindow(guest, true);
    await viewer.page.getByText("Allowed", { exact: true }).waitFor({ timeout: wait });
    await shot(viewer, "allowed");
    await setWindow(guest, false);
  });

  await step("the Episode keeps the guest's Focus record", async () => {
    const { episodes } = await system("GET", `/v1/tenants/${seed.tenantId}/spaces/${seed.spaceId}/episodes`);
    const live = episodes.at(0);
    if (!live) throw new Error("the call's Space has no Episode");
    const url = `/v1/tenants/${seed.tenantId}/spaces/${seed.spaceId}/episodes/${live.id}/focus`;
    // The guest's last interval closes when the window comes back, so the record settles a moment after the last step.
    const deadline = Date.now() + wait;
    let focus = await system("GET", url);
    const kept = (record) => record.participants.some((person) => person.display_name === guest.name && person.times_away >= 1 && person.step_aways.some((away) => away.reason === "reading")) && record.allow_windows.length >= 1;
    while (!kept(focus) && Date.now() < deadline) {
      await delay(1000);
      focus = await system("GET", url);
    }
    await writeFile(join(out, "focus.json"), `${JSON.stringify(focus, null, 2)}\n`);
    if (!kept(focus)) throw new Error(`the Episode's Focus record does not hold the guest's away time, step away and allowance: ${JSON.stringify(focus)}`);
  });
});
