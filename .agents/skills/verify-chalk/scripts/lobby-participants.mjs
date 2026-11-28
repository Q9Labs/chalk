#!/usr/bin/env node
// Drives the lobby: AI participants and people who are already in a call are named on one line before a visitor joins.
//
//   node .agents/skills/verify-chalk/scripts/lobby-participants.mjs <run-id> [--web <origin>]
//
// A host starts a call. The API admits two AI participants, so a visitor who opens the link sees them named with the AI badge.
// Three more participants make a crowd: the line names the AI participants and counts the others, and the others list opens.
// The visitor joins. A second visitor on a phone sees the same line.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { runJourney } from "./journey.mjs";

await runJourney("lobby-participants", async ({ step, person, startCall, leave, shot, seed, web, out, people }) => {
  const host = await person("LobbyHost", 1);
  const guest = await person("LobbyGuest", 2);
  const phone = await person("LobbyPhone", 3, { device: "android" });
  let call;
  let episodeId;
  let apiKey;

  const admit = async (name, kind) => {
    const response = await fetch(new URL("/v1/tenants/" + call.tenantId + "/spaces/" + call.spaceId + "/episodes/" + episodeId + "/participants", web), {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ name, role: "collaborator", identity_kind: kind, admission: "direct" }),
    });
    if (!response.ok) throw new Error("admitting " + name + " answered HTTP " + response.status + " " + ((await response.json().catch(() => null))?.error?.code ?? ""));
  };
  const lobbyLine = (who) => who.page.getByTestId("lobby.names");
  const aiBadges = (who) => lobbyLine(who).locator("[aria-label='AI participant']");

  await step("the host starts a call", async () => {
    call = await startCall(host);
    const episodes = await fetch(new URL("/v1/tenants/" + call.tenantId + "/spaces/" + call.spaceId + "/episodes", web), { headers: { Authorization: "Bearer " + seed.systemToken } }).then((r) => r.json());
    episodeId = (episodes.episodes ?? []).at(0)?.id;
    if (!episodeId) throw new Error("the call has no Episode");
  });

  await step("the API admits two AI participants", async () => {
    const created = await fetch(new URL("/v1/tenants/" + call.tenantId + "/api-keys", web), {
      method: "POST",
      headers: { Authorization: "Bearer " + seed.systemToken, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ name: "Lobby journey", scopes: ["episodes:read", "episodes:write", "spaces:read"], expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    });
    const body = await created.json().catch(() => null);
    apiKey = body?.token ?? body?.secret ?? body?.api_key_secret ?? body?.key;
    if (!created.ok || typeof apiKey !== "string") throw new Error("creating a backend credential answered HTTP " + created.status + ", fields " + Object.keys(body ?? {}).join(","));
    await admit("Scribe", "agent");
    await admit("Aria", "agent");
  });

  await step("a visitor sees who is here on one line, with the AI badge after each AI name and no notice", async () => {
    await guest.page.goto(call.link);
    await lobbyLine(guest).waitFor({ timeout: 30_000 });
    const text = (await lobbyLine(guest).textContent()) ?? "";
    for (const part of ["LobbyHost", "Scribe", "Aria", "are in this call"]) if (!text.includes(part)) throw new Error("the lobby line is " + JSON.stringify(text) + ", missing " + part);
    if ((await aiBadges(guest).count()) !== 2) throw new Error("expected two AI badges in the lobby line");
    if ((await guest.page.getByText("Only you see this").count()) > 0) throw new Error("the Only you see this pill is still there");
    if ((await guest.page.getByText(/transcribe/i).count()) > 0) throw new Error("a transcription notice is showing");
    await shot(guest, "lobby-light");
    await guest.page.emulateMedia({ colorScheme: "dark" });
    await shot(guest, "lobby-dark");
    await guest.page.emulateMedia({ colorScheme: "light" });
  });

  await step("a phone visitor sees the same line", async () => {
    await phone.page.goto(call.link);
    await lobbyLine(phone).waitFor({ timeout: 30_000 });
    await shot(phone, "lobby-phone-light");
    await phone.page.emulateMedia({ colorScheme: "dark" });
    await phone.page.waitForTimeout(800);
    await shot(phone, "lobby-phone-dark");
    await phone.page.emulateMedia({ colorScheme: "light" });
  });

  await step("with more people the line names the AI participants and counts the others, and the list opens", async () => {
    await admit("Recap", "agent");
    await admit("Priya Raman", "user");
    await admit("Tomás Herrera", "user");
    for (const who of [guest, phone]) {
      await who.page.reload();
      await lobbyLine(who).waitFor({ timeout: 30_000 });
      const text = (await lobbyLine(who).textContent()) ?? "";
      if (!/3 others/.test(text)) throw new Error("the lobby line is " + JSON.stringify(text) + ", expected 3 others");
      await shot(who, "lobby-crowd");
      await who.page.getByTestId("lobby.others").click();
      await who.page.getByText(/^\d+ in this call$/).waitFor({ timeout: 10_000 });
      await who.page.waitForTimeout(600);
      await shot(who, "lobby-crowd-open");
      await who.page.keyboard.press("Escape");
    }
  });

  await step("the visitor joins the call", async () => {
    await guest.page.getByLabel("Your name", { exact: true }).fill(guest.name);
    await guest.page.getByRole("button", { name: "Join call", exact: true }).click();
    await guest.page.getByRole("button", { name: "Video tile for " + guest.name, exact: true }).waitFor({ timeout: 60_000 });
    await shot(guest, "in-call");
  });

  await step("the visitor leaves", async () => {
    await leave(guest);
  });
});
