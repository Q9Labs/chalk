import { afterEach, expect, it, vi } from "vitest";
import { configuration } from "./config";
import { clearSeatCookies, clearSession, readCookie, seal, unseal, writeCookie } from "./cookies";
import { readOwnerSeat, writeOwnerSeat, type OwnerSeat } from "./owner-seats";
import type { Identity } from "./identity";

const env = configuration({
  CHALK_ENVIRONMENT: "test",
  CHALK_API_ORIGIN: "https://engine.example.test",
  DASHBOARD_ORIGIN: "https://dashboard.example.test",
  GOOGLE_CLIENT_ID: "google",
  GOOGLE_CLIENT_SECRET: "secret",
  APPLE_SERVICES_ID: "apple",
  APPLE_TEAM_ID: "team",
  APPLE_KEY_ID: "key",
  APPLE_PRIVATE_KEY: "key",
  SESSION_SECRET: "a-session-secret-with-at-least-32-characters",
  DASHBOARD_SERVICE_TOKEN: "service",
  DASHBOARD_IDENTITY_PROVIDER: "fixture",
});
const person: Identity = { provider: "google", userId: "owner", sessionId: "session", name: "Owner", email: "", avatarUrl: null, expiresAt: Date.now() + 3600000 };
function seat(spaceId = crypto.randomUUID()): OwnerSeat {
  return { userId: person.userId, sessionId: person.sessionId, spaceId, episodeId: crypto.randomUUID(), participantId: crypto.randomUUID(), generation: 1, joinKey: crypto.randomUUID(), expiresAt: Date.now() + 300000 };
}
function request(response = new Response()): Request {
  return new Request(env.DASHBOARD_ORIGIN, {
    headers: {
      Cookie: response.headers
        .getSetCookie()
        .filter((value) => !value.includes("Max-Age=0"))
        .map((value) => value.split(";")[0])
        .join("; "),
    },
  });
}
afterEach(() => vi.restoreAllMocks());

it("bounds the compatibility cache across 300 joins and Spaces without owning active tab authority", async () => {
  const original = seat();
  const handle = await seal(original, env.SESSION_SECRET, "owner-seat");
  let incoming = request();
  for (let join = 0; join < 300; join++) {
    const response = new Response();
    await writeOwnerSeat(incoming, response, env, person, seat());
    expect(response.headers.getSetCookie()).toHaveLength(1);
    expect(response.headers.get("Set-Cookie")).toMatch(/Max-Age=29\d|Max-Age=300/);
    incoming = request(response);
  }
  const cache = readCookie(incoming, env, "seats");
  if (!cache) throw new Error("Missing seat cache");
  expect(cache.length).toBeLessThan(4096);
  expect(await unseal(cache, env.SESSION_SECRET, "owner-seats")).toHaveLength(4);
  await expect(readOwnerSeat(incoming, env, person, { spaceId: original.spaceId, joinKey: original.joinKey, ownerSeat: handle })).resolves.toEqual(original);
  await expect(readOwnerSeat(incoming, env, person, { spaceId: original.spaceId, joinKey: original.joinKey })).rejects.toMatchObject({ status: 401 });
});

it("checks the sealed handle's user, session, Space, join key and absolute expiry", async () => {
  const original = seat();
  const input = { spaceId: original.spaceId, joinKey: original.joinKey, ownerSeat: await seal(original, env.SESSION_SECRET, "owner-seat") };
  const authorize = (identity = person, action = input) => readOwnerSeat(request(), env, identity, action);
  await expect(authorize()).resolves.toEqual(original);
  await expect(authorize({ ...person, userId: "other" })).rejects.toMatchObject({ code: "join_required" });
  await expect(authorize({ ...person, sessionId: "other" })).rejects.toMatchObject({ code: "join_required" });
  await expect(authorize(person, { ...input, spaceId: crypto.randomUUID() })).rejects.toMatchObject({ code: "join_required" });
  await expect(authorize(person, { ...input, joinKey: crypto.randomUUID() })).rejects.toMatchObject({ code: "join_required" });
  await expect(authorize(person, { ...input, ownerSeat: `${input.ownerSeat.slice(0, -8)}AAAAAAAA` })).rejects.toMatchObject({ code: "invalid_cookie" });
  vi.spyOn(Date, "now").mockReturnValue(original.expiresAt);
  await expect(authorize()).rejects.toMatchObject({ code: "join_required" });
});

it("migrates a loaded legacy single tab, and clears every seat cookie on leave/end and sign-out", async () => {
  const original = seat();
  const legacy = new Response();
  writeCookie(legacy, env, `seat_${original.spaceId}`, await seal(original, env.SESSION_SECRET, "owner-seat"));
  writeCookie(legacy, env, `seat_${original.spaceId}_${original.joinKey}`, "old-keyed-cookie");
  const incoming = request(legacy);
  await expect(readOwnerSeat(incoming, env, person, { spaceId: original.spaceId })).resolves.toEqual(original);
  const refreshed = new Response();
  await writeOwnerSeat(incoming, refreshed, env, person, original);
  expect(refreshed.headers.getSetCookie().filter((value) => value.includes("Max-Age=0"))).toHaveLength(2);
  await expect(readOwnerSeat(request(refreshed), env, person, { spaceId: original.spaceId })).resolves.toEqual(original);
  for (const clear of [clearSeatCookies, (response: Response, input: Request) => clearSession(response, env, input)]) {
    const response = new Response();
    clear(response, incoming, env);
    const cookies = response.headers.getSetCookie();
    expect(cookies.every((value) => value.includes("Max-Age=0"))).toBe(true);
    expect(cookies.filter((value) => value.includes("chalk_seat"))).toHaveLength(3);
  }
});
