import { describe, expect, it } from "vitest";

import { isParsedAccessGrant, parseAccessGrant, parseParsedAccessGrant, requireParsedAccessGrant } from "./grant";

describe("access grant parsing", () => {
  it("brands distinct audiences and preserves the participant subject", async () => {
    const wire = accessWire();
    const parsed = parseParsedAccessGrant(wire);

    expect(parsed.subject).toEqual({ tenantId: "t", spaceId: "r", episodeId: "s", participantId: "p", participantGeneration: 3 });
    expect(isParsedAccessGrant(wire)).toBe(true);
    await expect(requireParsedAccessGrant(wire)).resolves.toEqual(parsed);
  });

  it("rejects expired-shape and cross-audience data at the wire boundary", () => {
    const wire = accessWire();
    expect(() => parseParsedAccessGrant({ ...wire, media: { ...wire.media, token: wire.sync.token } })).toThrowError(expect.objectContaining({ code: "access.invalid" }));
    expect(() => parseParsedAccessGrant({ ...wire, sync: { ...wire.sync, expires_at: "not-a-date" } })).toThrowError(expect.objectContaining({ code: "access.invalid" }));
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

  it("keeps a server-minted grant serializable for the browser handoff", () => {
    const wire = accessWire();
    const grant = parseAccessGrant(wire);

    expect(JSON.parse(JSON.stringify(grant))).toEqual(wire);
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
