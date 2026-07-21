import { createServer, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { describe, expect, it } from "vitest";

describe("public SDK room", () => {
  it("creates one ChalkSession and consumes state through the React SDK surface", () => {
    const source = roomSource();
    expect(source.match(/new ChalkSession\(/gu)).toHaveLength(1);
    expect(source).toContain("<ChalkProvider");
    expect(source).toContain("<PreJoinLobby");
    expect(source).toContain("<SessionMeetingRoom");
    expect(source).toContain("initialMicrophoneEnabled: settings.microphoneEnabled");
    expect(source).toContain("initialCameraEnabled: settings.cameraEnabled");
  });

  it("contains no browser API key, identity environment, or direct transport orchestration", () => {
    const source = roomSource();
    expect(source).not.toContain("VITE_CHALK_LOCAL_API_TOKEN");
    expect(source).not.toContain("VITE_CHALK_TENANT_ID");
    expect(source).not.toContain("createV3SyncClient");
    expect(source).not.toContain("CloudflareSFUClient");
    expect(source).not.toContain("createCloudflareSFUHTTPTransport");
  });

  it("schedules a best-effort SDK leave after a real SPA unmount", () => {
    const source = roomSource();
    expect(source).toContain("mountedSessions.set(session, true)");
    expect(source).toContain("queueMicrotask");
    expect(source).toMatch(/session\s*\.leave\(\)/u);
  });

  it("proxies the narrow local backend without injecting authorization", () => {
    const source = readFileSync(joinPath(process.cwd(), "vite.config.ts"), "utf8");
    expect(source).toContain('"/local-chalk"');
    expect(source.toLowerCase()).not.toContain("authorization");
  });
});

function roomSource(): string {
  return readFileSync(joinPath(process.cwd(), "src/routes/room.tsx"), "utf8");
}

describe("localhost Chalk backend trust boundary", () => {
  it("keeps identity server-side and rejects non-local hosts and unapproved origins", async () => {
    const { createLocalChalkHandler } = await import("../../scripts/local-chalk-backend.mjs");
    const calls: { readonly operation: string; readonly arguments: readonly unknown[] }[] = [];
    let admitAttempts = 0;
    const chalk = {
      rooms: {
        create: async (...arguments_: unknown[]) => {
          calls.push({ operation: "rooms.create", arguments: arguments_ });
          return { id: "room-server" };
        },
      },
      sessions: {
        create: async (...arguments_: unknown[]) => {
          calls.push({ operation: "sessions.create", arguments: arguments_ });
          return { id: "session-server" };
        },
      },
      participants: {
        admit: async (...arguments_: unknown[]) => {
          calls.push({ operation: "participants.admit", arguments: arguments_ });
          admitAttempts += 1;
          if (admitAttempts === 1) throw new Error("simulated response loss");
          return { participant: { generation: 7 }, access: { source: "admission" } };
        },
        issueAccess: async (...arguments_: unknown[]) => {
          calls.push({ operation: "participants.issueAccess", arguments: arguments_ });
          return { source: "refresh" };
        },
      },
    };
    const ids = ["cookie-server", "room-suffix", "participant-server", "cookie-guest", "participant-guest"];
    const handler = createLocalChalkHandler({
      chalk,
      apiBaseURL: "http://127.0.0.1:8080",
      syncURL: "ws://127.0.0.1:4100/v3/sync",
      allowedOrigins: ["http://127.0.0.1:3070"],
      randomUUID: () => ids.shift() ?? "unexpected-id",
    });
    const server = createServer((request, response) => void handler(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP address");
    const url = `http://127.0.0.1:${address.port}`;

    try {
      const forbiddenHost = await rawPost(`${url}/local-chalk/browser-session`, { host: "attacker.test", origin: "http://127.0.0.1:3070" }, { displayName: "Ada" });
      expect(forbiddenHost.status).toBe(403);

      const forbiddenOrigin = await fetch(`${url}/local-chalk/browser-session`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://attacker.test" },
        body: JSON.stringify({ displayName: "Ada" }),
      });
      expect(forbiddenOrigin.status).toBe(403);

      const identityInjection = await fetch(`${url}/local-chalk/browser-session`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:3070" },
        body: JSON.stringify({ displayName: "Ada", tenantId: "attacker-tenant" }),
      });
      expect(identityInjection.status).toBe(400);

      const created = await fetch(`${url}/local-chalk/browser-session`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:3070" },
        body: JSON.stringify({ displayName: "Ada" }),
      });
      expect(created.status).toBe(201);
      expect(created.headers.get("cache-control")).toBe("no-store");
      const setCookie = created.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("chalk_local_session=cookie-server");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(await created.json()).toEqual({ apiBaseURL: "http://127.0.0.1:8080", syncURL: "ws://127.0.0.1:4100/v3/sync" });
      expect(calls).toEqual([]);

      const cookie = setCookie.split(";", 1)[0] ?? "";
      const lostAdmissionResponse = await fetch(`${url}/local-chalk/access`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:3070", cookie },
        body: JSON.stringify({}),
      });
      expect(lostAdmissionResponse.status).toBe(502);

      const admitted = await fetch(`${url}/local-chalk/access`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:3070", cookie },
        body: JSON.stringify({}),
      });
      expect(admitted.status).toBe(201);
      expect(await admitted.json()).toEqual({ source: "admission" });
      const admitCalls = calls.filter((call) => call.operation === "participants.admit");
      expect(admitCalls[0]?.arguments).toEqual(["room-server", "session-server", { participant_session_id: "participant-server", name: "Ada", initial_role: "host", eligible_roles: ["host", "cohost", "participant"] }, { idempotencyKey: "local-browser-participant-server" }]);
      expect(admitCalls[1]?.arguments).toEqual(admitCalls[0]?.arguments);
      expect(admitCalls).toHaveLength(2);
      expect(calls.filter((call) => call.operation === "participants.issueAccess")).toHaveLength(0);

      const refreshed = await fetch(`${url}/local-chalk/access`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:3070", cookie },
        body: JSON.stringify({ currentMediaToken: "opaque-media-token", replaceMediaConnection: true }),
      });
      expect(refreshed.status).toBe(201);
      const accessCall = [...calls].reverse().find((call) => call.operation === "participants.issueAccess");
      expect(accessCall?.arguments).toEqual(["room-server", "session-server", "participant-server", { participantSessionGeneration: 7, currentMediaToken: "opaque-media-token", replaceMediaConnection: true }]);

      const guestSession = await fetch(`${url}/local-chalk/browser-session`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:3070" },
        body: JSON.stringify({ displayName: "Grace" }),
      });
      const guestCookie = (guestSession.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
      const guestAccess = await fetch(`${url}/local-chalk/access`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:3070", cookie: guestCookie },
        body: JSON.stringify({}),
      });
      expect(guestAccess.status).toBe(201);
      expect(calls.filter((call) => call.operation === "participants.admit").at(-1)?.arguments).toEqual([
        "room-server",
        "session-server",
        { participant_session_id: "participant-guest", name: "Grace", initial_role: "participant", eligible_roles: ["participant", "cohost"] },
        { idempotencyKey: "local-browser-participant-guest" },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }, 15_000);
});

function rawPost(url: string, headers: Readonly<Record<string, string>>, body: unknown): Promise<{ readonly status: number }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = httpRequest(url, { method: "POST", headers: { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode ?? 0 }));
    });
    request.once("error", reject);
    request.end(payload);
  });
}
