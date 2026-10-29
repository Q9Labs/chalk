import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { credentialExpiries, issueCredentialRefresh, waitForCredentialRefresh } from "./credential-refresh.mjs";

test("refresh attempts retain outcomes without counting replacements or leaking credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-refresh-"));
  const refresh = { count: 0, latestExpiry: 0, requests: [] };
  const refreshes = [refresh];
  const expiresAt = "2026-10-29T12:00:00Z";
  const grant = { media: { expires_at: expiresAt, token: "private-media-sentinel" }, sync: { expires_at: expiresAt, token: "private-sync-sentinel" } };
  try {
    for (const replaceMediaConnection of [false, true]) {
      assert.equal(await issueCredentialRefresh({ directory }, refreshes, refresh, { reason: "refresh", replaceMediaConnection }, async () => grant), grant);
    }
    const denied = Object.assign(new Error("private-error-sentinel"), { status: 403, code: "access.forbidden" });
    await assert.rejects(
      issueCredentialRefresh({ directory }, refreshes, refresh, { reason: "refresh", replaceMediaConnection: false }, async () => {
        throw denied;
      }),
      (error) => error === denied,
    );
    assert.equal(refresh.count, 1);
    assert.equal(refresh.latestExpiry, Date.parse(expiresAt));
    const evidence = await readFile(join(directory, "credential-refresh.json"), "utf8");
    assert.deepEqual(JSON.parse(evidence), refreshes);
    assert.deepEqual(
      refresh.requests.map(({ status, code, replaceMediaConnection }) => ({ status, code, replaceMediaConnection })),
      [
        { status: 201, code: undefined, replaceMediaConnection: false },
        { status: 201, code: undefined, replaceMediaConnection: true },
        { status: 403, code: "access.forbidden", replaceMediaConnection: false },
      ],
    );
    assert.doesNotMatch(evidence, /private-.*-sentinel/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("server SDK grants prove renewal and hold both guests past their original expiry", async () => {
  const requireSDK = createRequire(new URL("../../sdks/typescript/client/package.json", import.meta.url));
  const { build } = requireSDK("esbuild");
  const bundle = await build({ entryPoints: [new URL("../../sdks/typescript/client/src/server/index.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node" });
  const { createChalkServerClient, getAccessRefreshState } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  const initialExpiry = Date.now() + 300_000;
  const latestExpiry = initialExpiry + 240_000;
  const token = (aud) => `header.${Buffer.from(JSON.stringify({ aud })).toString("base64url")}.signature`;
  const access = (expiresAt) => ({
    subject: { tenant_id: "tenant", space_id: "space", episode_id: "episode", participant_id: "participant", participant_generation: 1 },
    sync: { token: token("chalk-sync"), expires_at: new Date(expiresAt).toISOString() },
    media: { token: token("chalk-media"), expires_at: new Date(expiresAt).toISOString(), provider: "cloudflare_sfu", client_payload: { connectionId: "connection", stunServer: "stun:example.test" } },
  });
  const sdk = createChalkServerClient({
    apiKey: "synthetic",
    tenantId: "tenant",
    apiBaseURL: "https://example.test",
    fetch: async (url) => Response.json(String(url).endsWith("/participants") ? { participant: { id: "participant" }, access: access(initialExpiry) } : access(latestExpiry), { status: 201 }),
  });
  const initial = (await sdk.participants.admit("space", "episode", { name: "Proof guest", role: "owner" })).access;
  const renewed = await sdk.participants.issueAccess("space", "episode", "participant", getAccessRefreshState(initial));
  assert.deepEqual(credentialExpiries(initial), { mediaExpiry: initialExpiry, syncExpiry: initialExpiry });
  assert.deepEqual(credentialExpiries(renewed), { mediaExpiry: latestExpiry, syncExpiry: latestExpiry });
  const directory = await mkdtemp(join(tmpdir(), "chalk-refresh-"));
  let hold;
  let ready = false;
  try {
    const refreshes = [1, 2].map((guest) => ({ guest, count: 1, initialExpiry: credentialExpiries(initial).mediaExpiry, latestExpiry: credentialExpiries(renewed).mediaExpiry }));
    await waitForCredentialRefresh(
      {
        directory,
        wait: async (ms) => {
          hold = ms;
        },
      },
      refreshes,
      () => {
        ready = true;
      },
    );
    assert.ok(hold > 300_000 && hold <= 305_000, "must hold beyond original five-minute expiry");
    assert.equal(ready, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed refresh hold retains each guest's counters, expiries and access status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-refresh-"));
  const refreshes = [
    { guest: 1, count: 1, initialExpiry: 100, latestExpiry: 200, requests: [{ status: 201 }] },
    { guest: 2, count: 0, initialExpiry: 100, latestExpiry: 0, requests: [{ status: 403, code: "access.forbidden" }] },
  ];
  const controller = new AbortController();
  controller.abort(new Error("hold interrupted"));
  try {
    await assert.rejects(
      waitForCredentialRefresh({ directory, signal: controller.signal }, refreshes, () => {}),
      /hold interrupted/,
    );
    assert.deepEqual(JSON.parse(await readFile(join(directory, "credential-refresh.json"), "utf8")), refreshes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readiness failure after refresh still retains the successful refresh evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-refresh-"));
  const refreshes = [{ count: 1, initialExpiry: 100, latestExpiry: 200 }];
  try {
    await assert.rejects(
      waitForCredentialRefresh({ directory, wait: async () => {} }, refreshes, () => {
        throw new Error("guest disconnected");
      }),
      /guest disconnected/,
    );
    assert.deepEqual(JSON.parse(await readFile(join(directory, "credential-refresh.json"), "utf8")), refreshes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
