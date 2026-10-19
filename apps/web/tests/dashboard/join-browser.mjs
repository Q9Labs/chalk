import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

// Run through real-engine.sh. API, Postgres, Sync, SDK and the built dashboard
// are real; only the external media vendor is the existing local fixture.
assert(process.env.DASHBOARD_TEST_API_ORIGIN, "Run through real-engine.sh");
const apiOrigin = process.env.DASHBOARD_TEST_API_ORIGIN;
const origin = "http://127.0.0.1:18797";
const syncOrigin = "ws://127.0.0.1:18410/v1/sync";
const web = resolve(import.meta.dirname, "../..");
const repository = resolve(web, "../..");
const sandbox = await mkdtemp(resolve(tmpdir(), "chalk-dashboard-join-"));
const children = [];
const ownerFile = resolve(sandbox, "groups.json");
let browser;
let watchdog;
const deadline = setTimeout(() => {
  void cleanup().finally(() => process.exit(1));
}, 480000);
function start(command, args, cwd, env, log) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const saveGroups = () => {
    writeFileSync(`${ownerFile}.tmp`, JSON.stringify(children.filter((child) => child.exitCode === null && child.signalCode === null).map((child) => child.pid)));
    renameSync(`${ownerFile}.tmp`, ownerFile);
  };
  saveGroups();
  child.once("exit", saveGroups);
  child.stdout.on("data", (data) => log.push(data.toString()));
  child.stderr.on("data", (data) => log.push(data.toString()));
  return child;
}
async function command(command, args, cwd, env = {}) {
  const log = [];
  const child = start(command, args, cwd, env, log);
  const [code] = await once(child, "exit");
  assert.equal(code, 0, log.join(""));
}
async function ready(url, child, log) {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    assert.equal(child.exitCode, null, log.join(""));
    await delay(200);
  }
  throw Error(`Server did not become ready: ${log.join("")}`);
}
async function cleanup() {
  clearTimeout(deadline);
  await browser?.close();
  for (const child of children.toReversed()) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
  }
  await Promise.all(
    children.map((child) =>
      child.exitCode === null && child.signalCode === null
        ? Promise.race([
            once(child, "exit"),
            delay(5000).then(() => {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {}
            }),
          ])
        : undefined,
    ),
  );
  watchdog?.kill("SIGTERM");
  await rm(sandbox, { recursive: true, force: true });
}
process.once("SIGTERM", () => {
  void cleanup().finally(() => process.exit(143));
});
process.once("SIGINT", () => {
  void cleanup().finally(() => process.exit(130));
});
try {
  // An independent owner-loss watcher reaps only this proof's process groups.
  await writeFile(ownerFile, "[]");
  watchdog = spawn(
    process.execPath,
    [
      "-e",
      `const fs=require('node:fs');const owner=${process.pid},file=${JSON.stringify(ownerFile)};let seconds=0;setInterval(()=>{let live=true;try{process.kill(owner,0)}catch{live=false}if(live&&++seconds<490)return;for(const pid of JSON.parse(fs.readFileSync(file,'utf8'))){try{process.kill(-pid,'SIGKILL')}catch{}}process.exit()},1000);`,
    ],
    { stdio: "ignore", detached: true },
  );
  await command("pnpm", ["exec", "turbo", "run", "build", "--filter=web..."], repository, { VITE_API_URL: apiOrigin, VITE_CHALK_SYNC_URL: syncOrigin });
  await command("mix", ["deps.get"], resolve(repository, "apps/sync"), { MIX_ENV: "dev" });
  await command("mix", ["compile"], resolve(repository, "apps/sync"), { MIX_ENV: "dev" });
  const config = resolve(sandbox, "sync.exs");
  await writeFile(
    config,
    `
Application.put_env(:chalk_sync, :stateholder, ChalkSync.Stateholder.Postgres)
Application.put_env(:chalk_sync, :database_url, System.fetch_env!("CHALK_DATABASE_URL"))
Application.put_env(:chalk_sync, :instance_id, "dashboard-join-proof")
Application.put_env(:chalk_sync, :port, 18410)
Application.put_env(:chalk_sync, :token_verifier, ChalkSync.Auth.JWTTokenVerifier)
Application.put_env(:chalk_sync, :token_issuer, "dashboard-proof")
Application.put_env(:chalk_sync, :token_audience, "chalk-sync")
Application.put_env(:chalk_sync, :token_public_keys, %{"dashboard-proof" => Base.url_decode64!(System.fetch_env!("CHALK_SYNC_TOKEN_PRIVATE_KEY"), padding: false) |> binary_part(32,32)})
{:ok, _} = Application.ensure_all_started(:chalk_sync)
Process.sleep(:infinity)
`,
  );
  const syncLog = [];
  const sync = start("mix", ["run", "--no-start", config], resolve(repository, "apps/sync"), { MIX_ENV: "dev" }, syncLog);
  await ready("http://127.0.0.1:18410/healthz", sync, syncLog);
  const bindings = {
    CHALK_ENVIRONMENT: "test",
    CHALK_API_ORIGIN: apiOrigin,
    DASHBOARD_ORIGIN: origin,
    GOOGLE_CLIENT_ID: "fixture-client",
    GOOGLE_CLIENT_SECRET: "fixture-secret",
    APPLE_SERVICES_ID: "fixture-apple",
    APPLE_TEAM_ID: "fixture-team",
    APPLE_KEY_ID: "fixture-key",
    APPLE_PRIVATE_KEY: "fixture-key",
    SESSION_SECRET: "fixture-join-cookie-secret-at-least-32-characters",
    DASHBOARD_SERVICE_TOKEN: "fixture-dashboard-service-token-not-a-secret",
    DASHBOARD_IDENTITY_PROVIDER: "oauth",
  };
  const pagesLog = [];
  const pages = start("pnpm", ["exec", "wrangler", "pages", "dev", "dist/client", "--port", "18797", "--inspector-port", "0", ...Object.entries(bindings).flatMap(([k, v]) => ["--binding", `${k}=${v}`])], web, { CI: "true", WRANGLER_SEND_METRICS: "false" }, pagesLog);
  await ready(`${origin}/auth/session`, pages, pagesLog);
  const userId = `lane-test-${crypto.randomUUID()}`;
  const tenant = await fetch(`${apiOrigin}/v1/tenants`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bindings.DASHBOARD_SERVICE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Synthetic dashboard join", external_id: `google:test:${userId}`, cors_allowed_origins: [origin] }),
  });
  assert.equal(tenant.status, 201, await tenant.clone().text());
  const tenantId = (await tenant.json()).id;
  const identity = { provider: "google", userId, sessionId: crypto.randomUUID(), name: "Synthetic dashboard join", email: "", avatarUrl: null, expiresAt: Date.now() + 3600000 };
  const key = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", Buffer.from(bindings.SESSION_SECRET)), "AES-GCM", false, ["encrypt"]);
  async function seal(value, purpose) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: Buffer.from(purpose) }, key, Buffer.from(JSON.stringify(value)));
    return `${Buffer.from(iv).toString("base64url")}.${Buffer.from(ciphertext).toString("base64url")}`;
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 1440, height: 960 } });
  await context.addCookies(
    await Promise.all(
      [
        ["session", identity],
        ["binding", { userId, sessionId: identity.sessionId, expiresAt: identity.expiresAt }],
      ].map(async ([purpose, value]) => ({ name: `local_chalk_${purpose}`, value: await seal(value, purpose), url: origin, httpOnly: true, sameSite: "Lax" })),
    ),
  );
  const session = await context.request.get(`${origin}/auth/session`);
  assert.equal(session.status(), 200, await session.text());
  const page = await context.newPage();
  const sockets = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  try {
    await page.goto(`${origin}/dashboard`);
    await page.getByRole("button", { name: "Start a call", exact: true }).click();
    await page.getByRole("button", { name: "Join call", exact: true }).click();
    await page.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
    assert(
      sockets.some((url) => url.startsWith(syncOrigin)),
      "Dashboard ignored its configured Sync endpoint",
    );
    assert(
      sockets.every((url) => new URL(url).hostname === "127.0.0.1"),
      "Dashboard contacted a non-local Sync endpoint",
    );
    await page.screenshot({ path: resolve(repository, "artifacts/dashboard-owner-in-call.png") });
    const spaceId = new URL(page.url()).pathname.split("/").at(-2);
    const joinUrl = page.url();
    async function liveParticipants(expected) {
      let live;
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await fetch(`${apiOrigin}/v1/tenants/${tenantId}/live-episodes?space_ids=${spaceId}`, { headers: { Authorization: `Bearer ${bindings.DASHBOARD_SERVICE_TOKEN}` } });
        assert.equal(response.status, 200, await response.clone().text());
        live = (await response.json()).spaces[0]?.live_episode;
        if ((live?.participants.length ?? 0) === expected) return live;
        await delay(100);
      }
      assert.fail(`Expected ${expected} live seats, found ${live?.participants.length ?? 0}`);
    }
    const firstSeat = (await liveParticipants(1)).participants[0].participant_id;
    const callResponse = await context.request.get(`${origin}/dashboard-api/call?spaceId=${encodeURIComponent(spaceId)}`);
    assert.equal(callResponse.status(), 200, await callResponse.text());
    const call = await callResponse.json();
    assert.equal(new URL(call.inviteUrl).origin, apiOrigin, "Fixture must use an engine origin distinct from the dashboard");
    const readyLink = page.locator('[data-part="ready-link"]');
    await readyLink.waitFor({ state: "visible" });
    const displayed = await readyLink.innerText();
    assert(!displayed.includes("/dashboard/call/"), "In-call sharing exposed the owner-only dashboard join URL");
    assert(displayed.includes(call.inviteUrl.replace(/^https?:\/\//, "")), "In-call sharing did not display the engine canonical invite URL");
    await readyLink.getByRole("button", { name: "Copy link", exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(copied, call.inviteUrl, "In-call copy must preserve the exact engine canonical invite URL");
    assert(!copied.includes("/dashboard/call/"));
    const resumedAdmission = page.waitForResponse((response) => response.url() === `${origin}/dashboard-api/call` && response.request().method() === "POST" && response.request().postDataJSON()?.action === "join");
    await page.reload();
    const admitted = await resumedAdmission;
    assert.equal(admitted.status(), 200, await admitted.text());
    assert.equal((await admitted.json()).access.subject.participant_id, firstSeat, "Reload admission must replay the original owner seat");
    await page.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
    const afterReload = await liveParticipants(1);
    assert.equal(afterReload.participants[0].participant_id, firstSeat, "Same-tab reload must resume the exact owner seat");
    const otherTab = await context.newPage();
    try {
      await otherTab.goto(joinUrl);
      await otherTab.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
      const independent = await liveParticipants(2);
      assert(
        independent.participants.some((participant) => participant.participant_id !== firstSeat),
        "A separate tab must get its own seat",
      );
      await otherTab.getByRole("button", { name: "Leave call", exact: true }).click();
      await liveParticipants(1);
    } finally {
      await otherTab.close();
    }
    // An already-written reload marker must not survive an intentional leave.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    assert(await page.evaluate(() => sessionStorage.getItem("chalk.reload-rejoin")), "Pagehide must synchronously save the reload marker");
    await page.getByRole("button", { name: "Leave call", exact: true }).click();
    await page.waitForURL(`${origin}/dashboard/call/${spaceId}`);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("chalk.reload-rejoin")), null, "Intentional leave clears the reload marker");
    await liveParticipants(0);
    await page.goto(joinUrl);
    await page.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
    const afterRejoin = await liveParticipants(1);
    assert.notEqual(afterRejoin.participants[0].participant_id, firstSeat, "Deliberate leave then rejoin must create a new owner seat");
    await page.getByRole("button", { name: "Leave call", exact: true }).click();
    await liveParticipants(0);
    console.log("PASS: real dashboard create → real Sync → canonical invite displayed/copied → reload resumes one exact owner seat → independent tab gets separate seat → leave clears roster → deliberate rejoin gets new seat → no orphan (devices denied)");
  } catch (error) {
    await writeFile(resolve(repository, "artifacts/dashboard-join-failure.log"), JSON.stringify({ body: await page.locator("body").innerText(), sockets, sync: syncLog.join(""), pages: pagesLog.join("") }));
    throw error;
  }
  const leave = page.getByRole("button", { name: "Leave call", exact: true });
  if (await leave.isVisible()) await leave.click();
} finally {
  await cleanup();
}
