#!/usr/bin/env node
// Drives the call-length journey: a signed-in person starts a call from the site nav and another from the dashboard, both get the
// account's length policy, the call warns before its limit, extending moves the deadline, and each way a call ends says why.
//
//   node .agents/skills/verify-chalk/scripts/call-length.mjs <run-id> [--web <origin>]
//
// The local dashboard signs in as the fixture person Ada through "Continue with Google". Deadlines are moved with the API's
// set-deadline operation so the journey does not wait an hour; the limit, warning, extension and end are the product's own.
import { randomUUID } from "node:crypto";
import { runJourney } from "./journey.mjs";

const minute = 60_000;
const wait = 60_000;

await runJourney("call-length", async ({ step, person, shot, system, seed, web }) => {
  const ada = await person("Ada Fixture", 1);
  const { page } = ada;
  let tenantId;
  let nav;
  let dashboard;

  const callId = () => new URL(page.url()).pathname.match(/^\/dashboard\/call\/([0-9a-f-]{36})\/join$/)?.[1];
  const inCall = async () => {
    await page.waitForURL(/\/dashboard\/call\/[0-9a-f-]{36}\/join$/, { timeout: wait });
    await page.getByRole("region", { name: "Space stage", exact: true }).waitFor({ timeout: wait });
    return callId();
  };
  const episodeOf = async (spaceId) => {
    const { episodes } = await system("GET", `/v1/tenants/${tenantId}/spaces/${spaceId}/episodes`);
    const episode = episodes.at(0);
    if (!episode) throw new Error(`Space ${spaceId} has no Episode`);
    return episode;
  };
  const setDeadline = async (spaceId, episodeId, at) => {
    const response = await fetch(new URL(`/v1/tenants/${tenantId}/spaces/${spaceId}/episodes/${episodeId}/deadline`, web), {
      method: "POST",
      headers: { Authorization: `Bearer ${seed.systemToken}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ deadline_at: new Date(at).toISOString() }),
    });
    if (!response.ok) throw new Error(`set deadline answered HTTP ${response.status}`);
  };
  const untilEpisode = async (spaceId, ok, what) => {
    const until = Date.now() + wait;
    for (;;) {
      const episode = await episodeOf(spaceId);
      if (ok(episode)) return episode;
      if (Date.now() > until) throw new Error(`${what}: Episode is ${JSON.stringify({ status: episode.status, deadline_at: episode.deadline_at, end_reason: episode.end_reason })}`);
      await page.waitForTimeout(500);
    }
  };
  const hasAccountPolicy = async (spaceId) => {
    const space = await system("GET", `/v1/tenants/${tenantId}/spaces/${spaceId}`);
    if (space.default_episode_duration_seconds !== 3600 || space.maximum_episode_duration_seconds !== 86400) {
      throw new Error(`Space has ${space.default_episode_duration_seconds}/${space.maximum_episode_duration_seconds} s, not the account policy 3600/86400`);
    }
  };

  await step("Ada signs in to the dashboard", async () => {
    await page.goto(new URL("/dashboard", web).href);
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await page.getByRole("link", { name: "Ada", exact: true }).click();
    await page.getByRole("heading", { name: "Recent calls" }).waitFor({ timeout: wait });
    const { tenants } = await system("GET", "/v1/tenants?page_size=100");
    tenantId = tenants.find((tenant) => tenant.external_id === "google:local:fixture_ada")?.id;
    if (!tenantId) throw new Error("Ada's workspace is not in the tenant list");
  });

  await step("the site's Start a call opens an account call, not the anonymous entrance", async () => {
    await page.goto(new URL("/", web).href);
    await page.locator("nav a.btn.pri", { hasText: "Start a call" }).first().click();
    nav = await inCall();
    await hasAccountPolicy(nav);
    await shot(ada, "nav-call");
  });

  await step("the call warns ten minutes before its limit and offers more time", async () => {
    const episode = await episodeOf(nav);
    await setDeadline(nav, episode.id, Date.now() + 9 * minute);
    await page.getByText("10 minutes left.", { exact: false }).waitFor({ timeout: wait });
    await page.getByRole("button", { name: "Add 30 min", exact: true }).waitFor({ timeout: wait });
    await shot(ada, "ten-minute-warning");
  });

  await step("adding time moves the deadline and the call's clock", async () => {
    const before = Date.parse((await episodeOf(nav)).deadline_at);
    await page.getByRole("button", { name: "Add 30 min", exact: true }).click();
    const moved = await untilEpisode(nav, (episode) => Date.parse(episode.deadline_at) >= before + 29 * minute, "the deadline did not move");
    await page.getByText("10 minutes left.", { exact: false }).waitFor({ state: "hidden", timeout: wait });
    await shot(ada, "extended");
    return { before: new Date(before).toISOString(), after: moved.deadline_at };
  });

  await step("the call that reaches its limit ends and says why", async () => {
    const episode = await episodeOf(nav);
    await setDeadline(nav, episode.id, Date.now() + 15_000);
    await page.getByRole("heading", { name: "The call reached its time limit", exact: true }).waitFor({ timeout: wait });
    const ended = await untilEpisode(nav, (item) => item.status === "ended", "the call did not end");
    if (ended.end_reason !== "maximum_duration") throw new Error(`end_reason was ${ended.end_reason}`);
    await shot(ada, "time-limit-ended");
  });

  await step("a call started from the dashboard has the same policy", async () => {
    await page.goto(new URL("/dashboard", web).href);
    await page.getByRole("button", { name: "Start a call", exact: true }).first().click();
    await page.getByRole("button", { name: "Join call", exact: true }).click();
    dashboard = await inCall();
    await hasAccountPolicy(dashboard);
    await shot(ada, "dashboard-call");
  });

  await step("the host ending the call says the host ended it", async () => {
    await page.getByRole("region", { name: "Space stage", exact: true }).hover();
    await page.getByRole("button", { name: "Leave call", exact: true }).click();
    await page.getByRole("menuitem", { name: "End call for everyone", exact: true }).click();
    await page.getByText("The host ended this call for everyone.", { exact: false }).waitFor({ timeout: wait });
    const ended = await untilEpisode(dashboard, (item) => item.status === "ended", "the call did not end");
    if (!["ended_by_participant", "tenant_recovery"].includes(ended.end_reason)) throw new Error(`end_reason was ${ended.end_reason}`);
    await shot(ada, "host-ended");
  });
});
