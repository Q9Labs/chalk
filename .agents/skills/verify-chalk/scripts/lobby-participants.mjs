#!/usr/bin/env node
// Drives the lobby: AI participants and people who are already in a call are named on one line before a visitor joins.
//
//   node .agents/skills/verify-chalk/scripts/lobby-participants.mjs <run-id> [--web <origin>]
//
// A host starts a call. The API admits two AI participants, so a visitor who opens the link sees them named with the AI sparkle and a face-hash avatar like everyone else.
// Three more participants make a crowd: the line names the AI participants and counts the others, and the others list opens.
// The visitor joins. A second visitor on a phone sees the same line.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { runJourney } from "./journey.mjs";

await runJourney("lobby-participants", async ({ step, person, startCall, leave, shot, seed, web, out, people }) => {
  const host = await person("LobbyHost", 1);
  const guest = await person("LobbyGuest", 2, { permission: "granted" });
  const phone = await person("LobbyPhone", 3, { device: "android", permission: "granted" });
  let call;
  let episodeId;
  let apiKey;
  const fontProof = [];

  const admit = async (name, kind) => {
    const response = await fetch(new URL("/v1/tenants/" + call.tenantId + "/spaces/" + call.spaceId + "/episodes/" + episodeId + "/participants", web), {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json", "Idempotency-Key": randomUUID(), "X-Chalk-Media-Providers": call.mediaPlane },
      body: JSON.stringify({ participant_id: randomUUID(), name, role: "collaborator", identity_kind: kind, ...(kind === "agent" ? { identity_external_id: "lobby-journey-" + name.toLowerCase() } : {}), admission: "direct" }),
    });
    if (!response.ok) throw new Error("admitting " + name + " answered HTTP " + response.status + " " + ((await response.json().catch(() => null))?.error?.code ?? ""));
  };
  // The app reads its theme from a cookie, so the page follows only after a reload.
  const setTheme = async (who, theme) => {
    await who.context.addCookies([{ name: "chalk_theme", value: theme, url: web }]);
    await who.page.reload();
    await lobbyLine(who).waitFor({ timeout: 30_000 });
    await who.page.waitForTimeout(1200);
  };
  // Proof screenshots must show Chalk's own typeface, so a page that fell back to a system font fails the journey.
  const assertFigtree = async (who) => {
    const fonts = await who.page.evaluate(async () => {
      await document.fonts.ready;
      const line = document.querySelector("[data-testid='lobby.names']");
      return { family: line ? getComputedStyle(line).fontFamily : "", loaded: [...document.fonts].filter((face) => face.family.replace(/"/g, "") === "Figtree" && face.status === "loaded").length };
    });
    if (!/Figtree/.test(fonts.family) || fonts.loaded === 0) throw new Error(who.name + " renders " + fonts.family + " with " + fonts.loaded + " Figtree files loaded");
    return who.name + ": " + fonts.family + ", " + fonts.loaded + " Figtree file(s) loaded";
  };
  const lobbyLine = (who) => who.page.getByTestId("lobby.names");
  const aiSparkles = (who) => lobbyLine(who).locator("[aria-label='AI participant']");

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

  await step("a visitor sees who is here on one line, with the AI sparkle after each AI name, face-hash avatars and no notice", async () => {
    await guest.page.goto(call.link);
    await lobbyLine(guest).waitFor({ timeout: 30_000 });
    const text = (await lobbyLine(guest).textContent()) ?? "";
    for (const part of ["LobbyHost", "Scribe", "Aria", "are in this call"]) if (!text.includes(part)) throw new Error("the lobby line is " + JSON.stringify(text) + ", missing " + part);
    if ((await aiSparkles(guest).count()) !== 2) throw new Error("expected two AI sparkles in the lobby line");
    if (/\bAI\b/.test(text)) throw new Error("the lobby line still has an AI chip: " + JSON.stringify(text));
    for (const name of ["Aria", "Scribe", "LobbyHost"]) if ((await guest.page.locator("[data-testid='lobby.participants'] [aria-label='Avatar for " + name + "']").count()) === 0) throw new Error(name + " has no face-hash avatar in the lobby line");
    if ((await guest.page.locator("[aria-label='Avatar for You']").count()) === 0) throw new Error("the camera-off preview is not the face-hash avatar");
    if ((await guest.page.getByText("Only you see this").count()) > 0) throw new Error("the Only you see this pill is still there");
    if ((await guest.page.getByText(/transcribe/i).count()) > 0) throw new Error("a transcription notice is showing");
    fontProof.push(await assertFigtree(guest));
    await setTheme(guest, "dark");
    await shot(guest, "lobby-dark");
    await setTheme(guest, "light");
    await shot(guest, "lobby-light");
  });

  await step("a phone visitor sees the same line", async () => {
    await phone.page.goto(call.link);
    await lobbyLine(phone).waitFor({ timeout: 30_000 });
    fontProof.push(await assertFigtree(phone));
    await setTheme(phone, "dark");
    await shot(phone, "lobby-phone-dark");
    await setTheme(phone, "light");
    await shot(phone, "lobby-phone-light");
  });

  await step("with more people the line names the AI participants and counts the others, and the list opens", async () => {
    await admit("Recap", "agent");
    await admit("Priya Raman", "user");
    await admit("Tomás Herrera", "user");
    for (const who of [guest, phone]) {
      for (const theme of ["light", "dark"]) {
        await setTheme(who, theme);
        const text = (await lobbyLine(who).textContent()) ?? "";
        if (!/3 others/.test(text)) throw new Error("the lobby line is " + JSON.stringify(text) + ", expected 3 others");
        await who.page.waitForTimeout(1500);
        await shot(who, "lobby-crowd-" + theme);
        await who.page.getByTestId("lobby.others").click();
        await who.page.getByText(/^\d+ in this call$/).waitFor({ timeout: 10_000 });
        await who.page.waitForTimeout(2200);
        await shot(who, "lobby-crowd-open-" + theme);
        await who.page.keyboard.press("Escape");
        await who.page.waitForTimeout(300);
      }
    }
  });

  await step("every capture used Chalk's own typeface", async () => fontProof.join("; "));

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
