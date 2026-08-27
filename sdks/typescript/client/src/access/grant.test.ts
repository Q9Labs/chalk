import { describe, expect, it } from "vitest";

import { isParsedAccessGrant, parseAccessGrant, parseParsedAccessGrant, requireParsedAccessGrant } from "./grant";

describe("access grant parsing", () => {
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

  it("parses and preserves the RealtimeKit participant binding and client token", () => {
    const wire = { ...accessWire(), media: { ...accessWire().media, provider: "cloudflare_rtk", client_payload: { provider_subject: "participant-ref", token: "rtk-client-token" } } } as const;

    expect(parseParsedAccessGrant(wire).media).toEqual({
      token: wire.media.token,
      expiresAt: wire.media.expires_at,
      provider: "cloudflare_rtk",
      clientPayload: { providerSubject: "participant-ref", token: "rtk-client-token" },
    });
    expect(JSON.parse(JSON.stringify(parseAccessGrant(wire)))).toEqual(wire);
  });

  it("rejects unsupported media providers and incomplete RealtimeKit payloads", () => {
    const wire = accessWire();
    expect(() => parseParsedAccessGrant({ ...wire, media: { ...wire.media, provider: "realtimekit" } })).toThrowError(expect.objectContaining({ code: "access.invalid" }));
    expect(() => parseParsedAccessGrant({ ...wire, media: { ...wire.media, provider: "cloudflare_rtk", client_payload: { provider_subject: "participant-ref" } } })).toThrowError(expect.objectContaining({ code: "access.invalid" }));
  });

  it("binds a diagnostic credential to the participant generation", () => {
    const wire = { ...accessWire(), diagnostics: { token: diagnosticJwt(), expires_at: "2026-07-21T12:05:00.000Z", generation: 3, intake_path: "/_internal/episode-diagnostic-events" } };
    const parsed = parseParsedAccessGrant(wire);

    expect(parsed.diagnostics).toMatchObject({ generation: 3, intakePath: "/_internal/episode-diagnostic-events" });
    expect(JSON.parse(JSON.stringify(parseAccessGrant(wire)))).toEqual(wire);
    expect(parseParsedAccessGrant({ ...wire, diagnostics: { ...wire.diagnostics, generation: 4 } }).diagnostics).toBeNull();
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

function diagnosticJwt(): string {
  return `${btoa("header")}.${btoa(JSON.stringify({ aud: "chalk-diagnostics" }))}.signature`;
}
