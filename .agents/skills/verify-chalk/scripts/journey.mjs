// The harness the verify-chalk journeys share: seed, evidence folder, steps, browser logs, credential scan and verdict.
//
//   await runJourney("board-draw", async ({ step, person, startCall, joinByLink }) => { ... });
//
// Usage of a journey script: node <journey>.mjs <run-id> [--web <origin>]. Exit 0 means every step passed.
// People are the real product path: the host starts a call from /space/ (the person who starts a call is its owner,
// with every capability), and the second participant opens the host's invite link. Only camera and microphone are fakes.
import { chromium } from "playwright";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { webMediaFixture } from "../../../../scripts/web-proof/media.mjs";
import { collectPage } from "../../../../scripts/web-proof/tile-diagnostics.mjs";

const stage = { name: "Space stage", exact: true };

export async function runJourney(journey, body) {
  const runId = process.argv[2];
  if (!runId) throw new Error(`usage: ${journey}.mjs <run-id> [--web <origin>]`);
  const out = join(".verify", runId);
  const seed = JSON.parse(await readFile(".private/chalk-dev/seed.json", "utf8"));
  const flag = process.argv.indexOf("--web");
  const web = flag > 0 ? process.argv[flag + 1] : seed.urls.public;
  const steps = [];
  const logs = { console: [], network: [] };
  const people = [];
  await mkdir(join(out, "screenshots"), { recursive: true });
  await mkdir(join(out, "video"), { recursive: true });

  const step = async (name, run) => {
    const started = Date.now();
    try {
      const detail = await run();
      steps.push({ name, pass: true, ms: Date.now() - started, detail });
    } catch (error) {
      steps.push({ name, pass: false, ms: Date.now() - started, detail: String(error.message ?? error).slice(0, 600) });
      throw error;
    }
  };

  const system = async (method, path, payload) => {
    const response = await fetch(new URL(path, web), {
      method,
      headers: { Authorization: `Bearer ${seed.systemToken}`, ...(payload ? { "Content-Type": "application/json" } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    if (!response.ok) throw new Error(`${method} ${path} answered HTTP ${response.status}`);
    return response.json();
  };

  let browser;
  let failure;
  const shot = (person, label) => person.page.screenshot({ path: join(out, "screenshots", `${person.name}-${label}.png`) });

  const person = async (name, fixture) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, recordVideo: { dir: join(out, "video"), size: { width: 1440, height: 960 } } });
    await context.addInitScript(webMediaFixture(fixture));
    const page = await context.newPage();
    page.on("console", (message) => logs.console.push({ who: name, type: message.type(), text: message.text().slice(0, 300), url: message.location().url.replace(/[?#].*/, "") }));
    page.on("pageerror", (error) => logs.console.push({ who: name, type: "pageerror", text: String(error.message).slice(0, 300) }));
    page.on("response", (response) => {
      const { pathname } = new URL(response.url());
      if (!pathname.startsWith("/v1/")) return;
      logs.network.push({ who: name, method: response.request().method(), path: pathname, status: response.status() });
    });
    page.on("requestfailed", (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith("/v1/")) logs.network.push({ who: name, method: request.method(), path: pathname, error: request.failure()?.errorText });
    });
    const entry = { name, context, page };
    people.push(entry);
    return entry;
  };

  /** The host starts a call from /space/. Returns the invite link and the ids the API knows the call by. */
  const startCall = async (host) => {
    await host.page.goto(new URL("/space/", web).href);
    await host.page.getByLabel("Your name", { exact: true }).fill(host.name);
    const created = host.page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/v1/public/spaces");
    await host.page.getByRole("button", { name: "Join call", exact: true }).click();
    const response = await created;
    if (response.status() !== 201) throw new Error(`Start call answered HTTP ${response.status()}`);
    const call = await response.json();
    await host.page.getByRole("button", { name: `Video tile for ${host.name}`, exact: true }).waitFor({ timeout: 60_000 });
    await host.page.getByRole("button", { name: "Close call link", exact: true }).click();
    const { tenant_id: tenantId, space_id: spaceId } = call.arrival.access.subject;
    return { link: new URL(call.invite_link, web).href, tenantId, spaceId };
  };

  const enterLink = async (guest, link) => {
    await guest.page.goto(link);
    await guest.page.getByLabel("Your name", { exact: true }).fill(guest.name);
    await guest.page.getByRole("button", { name: "Join call", exact: true }).click();
  };

  /** The second participant opens the host's link and joins the call. */
  const joinByLink = async (guest, link) => {
    await enterLink(guest, link);
    await guest.page.getByRole("button", { name: `Video tile for ${guest.name}`, exact: true }).waitFor({ timeout: 60_000 });
  };

  /** Presses a control on the stage, which hides its controls until the stage is hovered. */
  const control = async (who, name) => {
    await who.page.getByRole("region", stage).hover();
    await who.page.getByRole("button", { name, exact: true }).click();
  };

  /** Leaves the call. The owner's Leave button first asks between leaving and ending the call for everyone. */
  const leave = async (who) => {
    await control(who, "Leave call");
    const leaving = who.page.getByRole("menuitem", { name: "Leave call", exact: true });
    const left = who.page.getByRole("button", { name: "Rejoin", exact: true });
    await leaving.or(left).first().waitFor({ timeout: 30_000 });
    if (await leaving.isVisible()) await leaving.click();
    await left.waitFor({ timeout: 30_000 });
  };

  try {
    browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
    await body({ seed, web, out, step, person, startCall, enterLink, joinByLink, control, leave, shot, system, people });
  } catch (error) {
    failure = String(error.message ?? error);
    const pages = await Promise.all(people.map((entry) => collectPage(entry, { tileNames: people.map((other) => other.name), logs, measurements: {} }).catch(() => undefined)));
    await writeFile(join(out, "diagnostics.json"), `${JSON.stringify({ failure, pages }, null, 2)}\n`);
    for (const entry of people) await shot(entry, "failure").catch(() => undefined);
  } finally {
    for (const { context } of people) await context.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }

  // Evidence must never carry a credential: scan every file we wrote for the values this run was given.
  const secrets = [seed.systemToken, process.env.CHALK_CLOUDFLARE_REALTIME_APP_SECRET, process.env.CHALK_CLOUDFLARE_REALTIME_APP_ID].filter(Boolean);
  await writeFile(join(out, "console.json"), `${JSON.stringify(logs.console, null, 2)}\n`);
  await writeFile(join(out, "network.json"), `${JSON.stringify(logs.network, null, 2)}\n`);
  const result = { journey, runId, web, pass: !failure && steps.every((entry) => entry.pass), failure, steps };
  await writeFile(join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  for (const entry of await readdir(out, { recursive: true })) {
    if (!/\.(json|log|txt)$/.test(entry)) continue;
    const text = await readFile(join(out, entry), "utf8");
    if (secrets.some((secret) => text.includes(secret))) {
      console.error(`evidence file ${entry} contains a credential`);
      process.exit(3);
    }
  }
  console.log(JSON.stringify({ pass: result.pass, failure, steps: steps.map((entry) => `${entry.pass ? "ok  " : "FAIL"} ${entry.name}`) }, null, 2));
  process.exit(result.pass ? 0 : 1);
}
