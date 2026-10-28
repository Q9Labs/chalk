import { describe, expect, it } from "vitest";
import { isParsedAccessGrant, parseAccessGrant, parseParsedAccessGrant, requireParsedAccessGrant, requireAccessGrant } from "./grant";
describe("access grant parsing", () => {
  describe.each([requireParsedAccessGrant, requireAccessGrant])("HTTP grant reader %s", (read) => {
    it("preserves a distinct superseded-binding conflict for explicit rejoin", async () => {
      await expect(read(Response.json({ error: { code: "participant.connection_superseded" } }, { status: 409 }))).rejects.toMatchObject({ code: "access.invalid", reason: "connection_superseded" });
    });
    it.each([408, 425, 429, 500, 502, 503, 504, 599])("classifies HTTP %s as unavailable", async (status) => {
      await expect(read(new Response(null, { status }))).rejects.toMatchObject({ code: "access.unavailable" });
    });
    it.each([400, 401, 403, 404, 409, 422, 499, 302])("classifies HTTP %s as invalid", async (status) => {
      await expect(read(new Response(null, { status }))).rejects.toMatchObject({ code: "access.invalid" });
    });
    it.each(["not-json", "{}"])("rejects a malformed successful body: %s", async (body) => {
      await expect(read(new Response(body))).rejects.toMatchObject({ code: "access.invalid" });
    });
  });
  it("brands distinct audiences and preserves the participant subject", async () => {
    const wire = accessWire();
    const parsed = parseParsedAccessGrant(wire);
    expect(parsed.subject).toEqual({ tenantId: "t", spaceId: "r", episodeId: "s", participantId: "p", participantGeneration: 3 });
    expect(isParsedAccessGrant(wire)).toBe(true);
    await expect(requireParsedAccessGrant(wire)).resolves.toEqual(parsed);
    expect(JSON.parse(JSON.stringify(parseAccessGrant(wire)))).toEqual(wire);
  });
  it("rejects expired-shape and cross-audience data at the wire boundary", () => {
    const wire = accessWire();
    expect(() => parseParsedAccessGrant({ ...wire, media: { ...wire.media, token: wire.sync.token } })).toThrowError(expect.objectContaining({ code: "access.invalid" }));
    expect(() => parseParsedAccessGrant({ ...wire, sync: { ...wire.sync, expires_at: "not-a-date" } })).toThrowError(expect.objectContaining({ code: "access.invalid" }));
  });
  it("preserves a valid Episode start time and ignores missing or malformed legacy values", () => {
    const wire = accessWire();
    expect(parseParsedAccessGrant({ ...wire, episode_started_at: "2026-08-25T10:00:00.000Z" }).episodeStartedAt).toBe("2026-08-25T10:00:00.000Z");
    expect(parseParsedAccessGrant(wire).episodeStartedAt).toBeNull();
    expect(parseParsedAccessGrant({ ...wire, episode_started_at: "not-a-date" }).episodeStartedAt).toBeNull();
  });
  it("rejects legacy subject aliases instead of widening the current wire contract", () => {
    const wire = accessWire();
    expect(() =>
      parseParsedAccessGrant({
        ...wire,
        subject: { tenant_id: "t", room_id: "r", session_id: "s", participant_session_id: "p", participant_generation: 3 },
      }),
    ).toThrowError(expect.objectContaining({ code: "access.invalid" }));
  });
  it("rejects unsupported media providers", () => {
    const wire = accessWire();
    expect(() => parseParsedAccessGrant({ ...wire, media: { ...wire.media, provider: "realtimekit" } })).toThrowError(expect.objectContaining({ code: "access.invalid" }));
    expect(() => parseParsedAccessGrant({ ...wire, media: { ...wire.media, provider: "cloudflare_rtk", client_payload: { provider_subject: "participant-ref" } } })).toThrowError(expect.objectContaining({ code: "access.invalid" }));
  });
});
function accessWire() {
  const jwt = (audience: string) => `${btoa("header")}.${btoa(JSON.stringify({ aud: audience }))}.signature`;
  return {
    subject: { tenant_id: "t", space_id: "r", episode_id: "s", participant_id: "p", participant_generation: 3 },
    sync: { token: jwt("chalk-sync"), expires_at: "2026-07-21T12:05:00.000Z" },
    media: { token: jwt("chalk-media"), expires_at: "2026-07-21T12:05:00.000Z", provider: "cloudflare_sfu", client_payload: { connectionId: "c", stunServer: "stun:test" } },
  } as const;
}
