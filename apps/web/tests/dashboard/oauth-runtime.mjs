import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const web = resolve(import.meta.dirname, "../..");
const sandbox = await realpath(await mkdtemp(resolve(tmpdir(), "chalk-oauth-workerd-")));
const encoder = new TextEncoder();
const b64 = (value) => Buffer.from(value).toString("base64url");
const challenge = async (value) => b64(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
const rsa = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const keys = await crypto.subtle.generateKey(rsa, true, ["sign", "verify"]);
const wrongKeys = await crypto.subtle.generateKey(rsa, true, ["sign", "verify"]);
const appleKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
const exchanges = [];
const keyRequests = { google: 0, apple: 0 };
const codes = new Map();
let tokenResponse;
let jwksResponse;
let trapRequests = 0;
let pages, watchdog, deadline;
let output = "";
let providerOrigin;
let origin;
const sessionSecret = "runtime-fixture-session-secret-at-least-32-characters";
async function signedToken(login) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: "RS256", kid: login.kid ?? "runtime-key" }));
  const payload = b64(
    JSON.stringify({ iss: login.provider === "google" ? "https://accounts.google.com" : "https://appleid.apple.com", aud: `${login.provider}-client`, sub: "subject", iat: now, exp: now + 300, nonce: login.nonce, name: "Person", email: "person@example.test", email_verified: true, ...login.claims }),
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", login.badSignature ? wrongKeys.privateKey : keys.privateKey, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64(signature)}`;
}
async function verifyAppleSecret(token) {
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "ES256", kid: "KEY1234567", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.iss, "TEAM123456");
  assert.equal(claims.sub, "apple-client");
  assert.equal(claims.aud, "https://appleid.apple.com");
  assert(claims.exp > Date.now() / 1000 && claims.exp - claims.iat <= 15777000);
  assert(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, appleKeys.publicKey, Buffer.from(signature, "base64url"), encoder.encode(`${header}.${payload}`)), "workerd Apple ES256 PKCS8 signature verifies");
}
function upstreamResponse(response, override) {
  response.writeHead(override.status, override.location ? { Location: override.location } : {});
  response.write(override.body.slice(0, 32768));
  response.end(override.body.slice(32768));
}
const upstream = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname === "/trap") {
      trapRequests++;
      response.end("{}");
      return;
    }
    const provider = url.pathname.startsWith("/google/") ? "google" : "apple";
    if (url.pathname.endsWith("/keys")) {
      keyRequests[provider]++;
      if (jwksResponse) return upstreamResponse(response, jwksResponse);
      response.setHeader("Cache-Control", "max-age=3600");
      response.end(JSON.stringify({ keys: [{ ...publicKey, kid: "runtime-key", alg: "RS256", use: "sig" }] }));
      return;
    }
    if (url.pathname.endsWith("/token")) {
      let body = "";
      for await (const part of request) body += part;
      const params = new URLSearchParams(body);
      exchanges.push(params);
      if (provider === "apple") await verifyAppleSecret(params.get("client_secret"));
      if (tokenResponse) return upstreamResponse(response, tokenResponse);
      const code = params.get("code");
      const login = codes.get(code);
      codes.delete(code);
      if (!login || (provider === "google" && (await challenge(params.get("code_verifier") ?? "")) !== login.challenge)) {
        response.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      response.end(JSON.stringify({ id_token: await signedToken(login) }));
      return;
    }
    if (url.pathname === "/v1/tenants/by-external-id") {
      response.end(
        JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          name: "Personal",
          external_id: url.searchParams.get("external_id"),
          cors_allowed_origins: [],
          default_media_plane: null,
          media_plane_provider_config: null,
          storage_provider_config: null,
          logo_key: null,
          website: null,
          transcription_ceiling: "on_demand",
          transcription_default_mode: "on_demand",
          provider_policy_version: "test",
          recording_retention_seconds: 3600,
          transcript_retention_seconds: 3600,
          transcription_source_window_seconds: 3600,
          created_at: "2026-10-18T12:00:00Z",
          updated_at: "2026-10-18T12:00:00Z",
        }),
      );
      return;
    }
    response.writeHead(404).end("{}");
  } catch (error) {
    console.error("Local provider fixture failed:", error);
    response.writeHead(500).end("{}");
  }
});
async function request(path, init = {}) {
  return fetch(`${origin}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(15000) });
}
async function start(provider) {
  const response = await request(`/auth/start?provider=${provider}`);
  assert.equal(response.status, 303);
  const url = new URL(response.headers.get("Location"));
  const cookie = response.headers.getSetCookie()[0];
  assert(cookie.includes("Max-Age=600"));
  const code = crypto.randomUUID();
  codes.set(code, { provider, nonce: url.searchParams.get("nonce"), challenge: url.searchParams.get("code_challenge"), claims: {} });
  return { provider, url, cookie: cookie.split(";")[0], code };
}
function callback(login, user) {
  const params = new URLSearchParams({ code: login.code, state: login.url.searchParams.get("state") });
  if (user !== undefined) params.set("user", user);
  return login.provider === "google"
    ? request(`/auth/callback/google?${params}`, { headers: { Cookie: login.cookie } })
    : request("/auth/callback/apple", { method: "POST", headers: { Cookie: login.cookie, Origin: "https://appleid.apple.com", "Content-Type": "application/x-www-form-urlencoded" }, body: params });
}
function noSession(response, provider) {
  assert.equal(response.headers.get("Location"), `/dashboard/sign-in?failed=${provider}`);
  assert(!response.headers.getSetCookie().some((cookie) => /local_chalk_(?:session|binding)=/.test(cookie)));
  assert(response.headers.getSetCookie().some((cookie) => cookie.includes(`local_chalk_login_${provider}=;`)));
  assert.match(response.headers.get("X-Request-ID"), /^[0-9a-f-]{36}$/);
}
async function rejectedWith(login, code) {
  const before = output.length;
  noSession(await callback(login), login.provider);
  await delay(100);
  assert(output.slice(before).includes(`"code":"${code}"`), `Expected bounded workerd error ${code}`);
}
async function transaction(login) {
  const [iv, ciphertext] = login.cookie.slice(login.cookie.indexOf("=") + 1).split(".");
  const key = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", encoder.encode(sessionSecret)), "AES-GCM", false, ["decrypt", "encrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(iv, "base64url"), additionalData: encoder.encode(`login_${login.provider}`) }, key, Buffer.from(ciphertext, "base64url"));
  return { key, value: JSON.parse(new TextDecoder().decode(plaintext)) };
}
async function expire(login) {
  const { key, value } = await transaction(login);
  assert(value.expiresAt > Date.now() && value.expiresAt <= Date.now() + 600000);
  value.expiresAt = Date.now() - 1;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(`login_${login.provider}`) }, key, encoder.encode(JSON.stringify(value)));
  login.cookie = `${login.cookie.split("=")[0]}=${b64(iv)}.${b64(ciphertext)}`;
}
try {
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  providerOrigin = `http://127.0.0.1:${upstream.address().port}`;
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  origin = `http://127.0.0.1:${port}`;
  await cp(resolve(web, "server"), resolve(sandbox, "server"), { recursive: true });
  await cp(resolve(web, "functions"), resolve(sandbox, "functions"), { recursive: true });
  await mkdir(resolve(sandbox, "src/lib/dashboard"), { recursive: true });
  await cp(resolve(web, "src/lib/dashboard/contracts.ts"), resolve(sandbox, "src/lib/dashboard/contracts.ts"));
  await symlink(resolve(web, "node_modules"), resolve(sandbox, "node_modules"), "dir");
  // Only external endpoint addresses change. Named routes, production composition,
  // handler, adapter, crypto, fetch options and generated client run in workerd.
  const oauthPath = resolve(sandbox, "server/oauth.ts");
  let oauth = await readFile(oauthPath, "utf8");
  for (const [url, path] of [
    ["https://oauth2.googleapis.com/token", "/google/token"],
    ["https://www.googleapis.com/oauth2/v3/certs", "/google/keys"],
    ["https://appleid.apple.com/auth/token", "/apple/token"],
    ["https://appleid.apple.com/auth/keys", "/apple/keys"],
  ])
    oauth = oauth.replaceAll(url, `${providerOrigin}${path}`);
  if (process.argv.includes("--redirect-error")) oauth = oauth.replace('redirect: "manual"', 'redirect: "error"');
  await writeFile(oauthPath, oauth);
  await mkdir(resolve(sandbox, "public"));
  await writeFile(resolve(sandbox, "public/index.html"), "OAuth runtime test");
  const bindings = {
    CHALK_ENVIRONMENT: "test",
    CHALK_API_ORIGIN: providerOrigin,
    DASHBOARD_ORIGIN: origin,
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "fixture-google-secret",
    APPLE_SERVICES_ID: "apple-client",
    APPLE_TEAM_ID: "TEAM123456",
    APPLE_KEY_ID: "KEY1234567",
    APPLE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey("pkcs8", appleKeys.privateKey)).toString("base64")}\n-----END PRIVATE KEY-----`, // gitleaks:allow — generated in memory above; never a stored credential
    SESSION_SECRET: sessionSecret,
    DASHBOARD_SERVICE_TOKEN: "fixture-service",
    DASHBOARD_IDENTITY_PROVIDER: "oauth",
  };
  await writeFile(
    resolve(sandbox, ".dev.vars"),
    Object.entries(bindings)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n"),
    { mode: 0o600 },
  );
  pages = spawn("pnpm", ["exec", "wrangler", "pages", "dev", "public", "--cwd", sandbox, "--port", `${port}`, "--inspector-port", "0", "--compatibility-date", "2024-12-01", "--compatibility-flags", "nodejs_compat"], {
    cwd: web,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  pages.stdout.on("data", (chunk) => {
    output += chunk;
  });
  pages.stderr.on("data", (chunk) => {
    output += chunk;
  });
  watchdog = spawn(process.execPath, ["-e", `const owner=${process.pid},group=${pages.pid};setInterval(()=>{try{process.kill(owner,0)}catch{try{process.kill(-group,'SIGTERM')}catch{}process.exit()}},1000).unref();setTimeout(()=>{try{process.kill(-group,'SIGTERM')}catch{}},185000);`], {
    stdio: "ignore",
  });
  deadline = setTimeout(() => {
    try {
      process.kill(-pages.pid, "SIGTERM");
    } catch {}
  }, 180000);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (pages.exitCode !== null) throw new Error(`Pages exited: ${output}`);
    try {
      if ((await request("/auth/session")).status === 401) break;
    } catch {}
    if (attempt === 99) throw new Error(`Pages never became ready: ${output}`);
    await delay(200);
  }
  for (const provider of ["google", "apple"]) {
    let login = await start(provider);
    let response = await callback(login);
    assert.equal(response.headers.get("Location"), "/dashboard", `${provider} callback must work in workerd (upstream exchanges: ${exchanges.length})`);
    assert(response.headers.getSetCookie().some((cookie) => cookie.startsWith("local_chalk_session=")));
    const sent = exchanges.at(-1);
    assert.equal(sent.get("redirect_uri"), `${origin}/auth/callback/${provider}`);
    if (provider === "google") assert.equal(await challenge(sent.get("code_verifier")), login.url.searchParams.get("code_challenge"));
    else assert(!sent.has("code_verifier"));
    const beforeReplay = exchanges.length;
    noSession(await callback(login), provider);
    assert.equal(exchanges.length, beforeReplay + 1);
    for (const invalid of ["state", "nonce", "expiry"]) {
      login = await start(provider);
      if (invalid === "state") login.url.searchParams.set("state", "bad-state");
      if (invalid === "expiry") await expire(login);
      if (invalid === "nonce") {
        const { value } = await transaction(login);
        const offset = JSON.stringify(value).indexOf('"nonce":"') + '"nonce":"'.length;
        const [iv, ciphertext] = login.cookie.slice(login.cookie.indexOf("=") + 1).split(".");
        const bytes = Buffer.from(ciphertext, "base64url");
        bytes[offset] ^= 1;
        login.cookie = `${login.cookie.split("=")[0]}=${iv}.${b64(bytes)}`;
      }
      const before = exchanges.length;
      noSession(await callback(login), provider);
      assert.equal(exchanges.length, before, `${invalid} transaction must not exchange`);
    }
    for (const claims of [
      { iss: "https://evil.example" },
      { aud: "wrong" },
      { exp: 1 },
      { exp: undefined },
      { exp: "later" },
      { iat: undefined },
      { iat: "now" },
      { iat: Math.floor(Date.now() / 1000) + 3600 },
      { iat: Math.floor(Date.now() / 1000) + 30, exp: Math.floor(Date.now() / 1000) + 10 },
      { nonce: "wrong-nonce" },
    ]) {
      login = await start(provider);
      codes.get(login.code).claims = claims;
      const before = exchanges.length;
      noSession(await callback(login), provider);
      assert.equal(exchanges.length, before + 1);
    }
    login = await start(provider);
    codes.get(login.code).badSignature = true;
    noSession(await callback(login), provider);
    for (const verified of [true, false, undefined, "true"]) {
      login = await start(provider);
      codes.get(login.code).claims = { email_verified: verified };
      response = await callback(login);
      assert.equal(response.headers.get("Location"), "/dashboard");
      const cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const session = await request("/auth/session", { headers: { Cookie: cookie } });
      assert.equal(session.status, 200);
      assert.equal((await session.json()).profile.email, provider === "google" && verified !== true ? "" : "person@example.test");
    }
    if (provider === "apple") {
      login = await start(provider);
      noSession(await callback(login, "\nMARKER"), provider);
      await delay(100);
      assert(!output.includes("MARKER"), "untrusted Apple input must never enter workerd logs");
      assert(output.includes('"error_type":"SyntaxError"'));
    }
    assert.equal(keyRequests[provider], 1, "known keys reuse the workerd JWKS cache");
    for (const status of [200, 400]) {
      login = await start(provider);
      tokenResponse = { status, body: " ".repeat(65537) };
      await rejectedWith(login, "identity_response_too_large");
      tokenResponse = undefined;
    }
    login = await start(provider);
    tokenResponse = { status: 302, body: "not JSON", location: `${providerOrigin}/trap` };
    await rejectedWith(login, `identity_${provider}_redirect`);
    tokenResponse = undefined;
    // Unknown kids force a JWKS refresh; failed refreshes must never issue sessions.
    for (const status of [200, 400, 302]) {
      login = await start(provider);
      codes.get(login.code).kid = `unknown-${status}`;
      jwksResponse = { status, body: status === 302 ? "not JSON" : " ".repeat(65537), location: `${providerOrigin}/trap` };
      await rejectedWith(login, status === 302 ? `identity_${provider}_redirect` : "identity_response_too_large");
      jwksResponse = undefined;
    }
    await delay(100);
    assert(output.includes(`identity_${provider}_redirect`), "provider redirects have bounded fixed codes");
    assert.equal(trapRequests, 0, "neither token nor JWKS redirects may be followed");
    console.log(`PASS: workerd ${provider} production adapter: PKCE/code forwarding, real crypto, sealed state/nonce/expiry, consumed code, claims/signature, email, bounded bodies and manual redirects`);
  }
  console.log("PASS: workerd Apple PKCS8 ES256 JWT verifies; AES-GCM/HMAC/RS256/SHA256, AbortSignal.timeout and real engine-client fetch execute without Node-only shims");
} catch (error) {
  await delay(100);
  console.error(output.slice(-10000));
  throw error;
} finally {
  clearTimeout(deadline);
  watchdog?.kill("SIGTERM");
  if (pages?.pid) {
    try {
      process.kill(-pages.pid, "SIGTERM");
    } catch {}
    await Promise.race([once(pages, "exit"), delay(3000)]);
    try {
      process.kill(-pages.pid, "SIGKILL");
    } catch {}
  }
  upstream.closeAllConnections();
  await new Promise((done) => upstream.close(done));
  await rm(sandbox, { recursive: true, force: true });
}
