import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

// Owns the real dashboard/Sync processes and synthetic signed-in browser.
export async function createDashboardProofFixture({ recordingName, devicesMissing = false } = {}) {
  assert(process.env.DASHBOARD_TEST_API_ORIGIN, "Run through real-engine.sh");
  const apiOrigin = process.env.DASHBOARD_TEST_API_ORIGIN;
  const webPort = process.env.CHALK_JOIN_WEB_PORT || "18797";
  const syncPort = process.env.CHALK_JOIN_SYNC_PORT || "18410";
  const origin = `http://127.0.0.1:${webPort}`;
  const syncOrigin = `ws://127.0.0.1:${syncPort}/v1/sync`;
  const web = resolve(import.meta.dirname, "../..");
  const repository = resolve(web, "../..");
  const sandbox = await mkdtemp(resolve(tmpdir(), "chalk-dashboard-join-"));
  const children = [];
  const ownerFile = resolve(sandbox, "groups.json");
  let browser;
  let recordingContext;
  let recording;
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
    try {
      await recordingContext?.close();
      await recording?.saveAs(resolve(repository, "artifacts", recordingName));
    } catch (error) {
      console.error("Browser recording finalization failed", error);
    }
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
Application.put_env(:chalk_sync, :port, ${syncPort})
Application.put_env(:chalk_sync, :provider_bridge,
  base_url: System.fetch_env!("CHALK_SYNC_PROVIDER_BRIDGE_URL"),
  certfile: System.fetch_env!("CHALK_SYNC_PROVIDER_BRIDGE_CERTFILE"),
  keyfile: System.fetch_env!("CHALK_SYNC_PROVIDER_BRIDGE_KEYFILE"),
  cacertfile: System.fetch_env!("CHALK_SYNC_PROVIDER_BRIDGE_CAFILE"))
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
    await ready(`http://127.0.0.1:${syncPort}/healthz`, sync, syncLog);
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
    const pages = start("pnpm", ["exec", "wrangler", "pages", "dev", "dist/client", "--port", webPort, "--inspector-port", "0", ...Object.entries(bindings).flatMap(([k, v]) => ["--binding", `${k}=${v}`])], web, { CI: "true", WRANGLER_SEND_METRICS: "false" }, pagesLog);
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
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 1440, height: 960 }, ...(recordingName ? { recordVideo: { dir: resolve(sandbox, "video"), size: { width: 1440, height: 960 } } } : {}) });
    recordingContext = context;
    if (devicesMissing)
      await context.addInitScript(() => {
        // Capture-device fixture: reproduce a computer with no capture devices.
        globalThis.__captureCalls = [];
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          globalThis.__captureCalls.push({ constraints, error: "NotFoundError" });
          throw new DOMException("No capture device found (fixture)", "NotFoundError");
        };
      });
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
    return {
      apiOrigin,
      origin,
      syncOrigin,
      repository,
      browser,
      context,
      tenantId,
      userId,
      bindings,
      syncLog,
      pagesLog,
      cleanup,
      recordPage: (page) => {
        recording = page.video();
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
