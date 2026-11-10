#!/usr/bin/env node
// Smoke for the direct door on a deployed web build: joins a temporary Space alternately with the default arm
// (the SDK uses the door the grant advertises) and the control arm (?direct=off, everything on the Tunnel), and
// records for each join which hosts carried Sync and SFU signalling, plus the time from Join to the in-call controls.
// Run it like `pnpm web:proof`: CHALK_PROOF_CONFIG_SOURCE=env with the environment's proof Tenant, plus
// CHALK_DOOR_HOST (the hostname of the direct door). Hold the staging SFU lease when the Space is on the own SFU.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createRun, loadConfig, save, maskCredentials, publicFailure, check, request } from "../prod-proof/runtime.mjs";
import { createEpisode, createSpace, prepareIntegration } from "../prod-proof/proofs.mjs";
import { cleanupRun, runLabel } from "../prod-proof/cleanup.mjs";

const joinsPerArm = Number(process.env.CHALK_DIRECT_JOINS ?? 10);
const doorHost = process.env.CHALK_DOOR_HOST;
const runId = process.env.CHALK_PROOF_RUN_ID ?? `direct-${randomUUID()}`;
runLabel(runId);
const directory = resolve(".private/prod-proof", runId);

/** Names the plane a host serves in this report, so the report holds no hostnames. */
const label = (host) => (host === doorHost ? "door" : "tunnel");

async function join(browser, entry, control) {
  const context = await browser.newContext({ permissions: ["microphone", "camera"] });
  const page = await context.newPage();
  const sync = new Set();
  const signalling = new Set();
  page.on("websocket", (socket) => {
    const url = new URL(socket.url());
    if (url.pathname === "/v1/sync") sync.add(label(url.host));
  });
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname.includes("/media/sfu/")) signalling.add(label(url.host));
  });
  try {
    await page.goto(entry);
    if (control) {
      // The web app drops the query when it canonicalises an invite link, so ask for the control arm on the settled URL.
      await page.getByLabel("Your name").waitFor();
      const settled = new URL(page.url());
      settled.searchParams.set("direct", "off");
      sync.clear();
      signalling.clear();
      await page.goto(settled.href);
    }
    await page.getByLabel("Your name").fill("Direct smoke");
    const started = performance.now();
    await page.getByRole("button", { name: "Join call", exact: true }).click();
    await page.getByRole("button", { name: "Leave call", exact: true }).waitFor({ state: "attached", timeout: 30_000 });
    const joinMs = Math.round(performance.now() - started);
    await page.waitForTimeout(1500);
    await page.getByRole("region", { name: "Space stage", exact: true }).hover();
    await page.getByRole("button", { name: "Leave call", exact: true }).click();
    await page.getByRole("button", { name: "Rejoin", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    const kept = new URL(page.url()).searchParams.get("direct");
    return { arm: control ? "control" : "direct", joinMs, kept, sync: [...sync].sort(), signalling: [...signalling].sort() };
  } finally {
    await context.close();
  }
}

let run;
let ending;
let failed = false;
try {
  check(process.env.CHALK_PROOF_CONFIG_SOURCE === "env" && doorHost, "Set CHALK_PROOF_CONFIG_SOURCE=env and CHALK_DOOR_HOST", "configuration");
  const config = await loadConfig({ readiness: false });
  await request(config, "GET", "/readyz");
  run = await createRun(config, directory, undefined, runId);
  await prepareIntegration(run, false);
  const space = await createSpace(run, "chalk_sfu");
  const { end } = await createEpisode(run, space);
  ending = end;
  const invite = await run.ownerRequest("PATCH", `${run.tenantPath}/spaces/${space.id}/public-invite`, { enabled: true });
  const url = new URL(invite.canonical_url);
  maskCredentials({ inviteToken: url.hash.slice(1), canonicalCredential: invite.canonical_url });
  const entry = new URL(`${url.pathname}${url.search}${url.hash}`, new URL(config.web_url).origin).href;
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const joins = [];
  try {
    for (let index = 0; index < joinsPerArm * 2; index += 1) joins.push(await join(browser, entry, index % 2 === 1));
  } finally {
    await browser.close();
  }
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/direct-path.json`, JSON.stringify(joins, null, 2));
  for (const arm of ["direct", "control"]) {
    const rows = joins.filter((row) => row.arm === arm);
    const times = rows.map((row) => row.joinMs).sort((a, b) => a - b);
    const median = times.length ? times[Math.floor(times.length / 2)] : null;
    const paths = (key) => [...new Set(rows.map((row) => row[key].join("+") || "none"))].join(" | ");
    console.log(`${arm}: ${rows.length} joins, median ${median} ms, min ${times[0]} ms, max ${times.at(-1)} ms; sync on [${paths("sync")}]; signalling on [${paths("signalling")}]; ?direct kept after Join: ${rows.filter((row) => row.kept === "off").length}/${rows.length}`);
  }
} catch (error) {
  failed = true;
  publicFailure("direct-path", error);
} finally {
  if (run) {
    try {
      await ending?.();
      await cleanupRun(run);
      console.log("cleanup: passed");
    } catch (error) {
      failed = true;
      publicFailure("direct-path-cleanup", error);
    }
  }
}
process.exitCode = failed ? 1 : 0;
