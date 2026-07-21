import { describe, expect, it } from "vitest";

import { isParticipantAccess, parseParticipantAccess, requireParticipantAccess } from "./access";

describe("participant access parsing", () => {
  it("brands distinct audiences and preserves the participant subject", async () => {
    const wire = accessWire();
    const parsed = parseParticipantAccess(wire);

    expect(parsed.subject).toEqual(wire.subject);
    expect(isParticipantAccess(wire)).toBe(true);
    await expect(requireParticipantAccess(wire)).resolves.toEqual(parsed);
  });

  it("rejects expired-shape and cross-audience data at the wire boundary", () => {
    const wire = accessWire();
    expect(() => parseParticipantAccess({ ...wire, media: { ...wire.media, token: wire.sync.token } })).toThrowError(expect.objectContaining({ code: "invalid_participant_access" }));
    expect(() => parseParticipantAccess({ ...wire, sync: { ...wire.sync, expiresAt: "not-a-date" } })).toThrowError(expect.objectContaining({ code: "invalid_participant_access" }));
  });
});

function accessWire() {
  const jwt = (audience: string) => `${btoa("header")}.${btoa(JSON.stringify({ aud: audience }))}.signature`;
  return {
    subject: { tenantId: "t", roomId: "r", sessionId: "s", participantSessionId: "p", participantGeneration: 3 },
    sync: { token: jwt("chalk-sync"), expiresAt: "2026-07-21T12:05:00.000Z" },
    media: { token: jwt("chalk-media"), expiresAt: "2026-07-21T12:05:00.000Z", provider: "cloudflare_sfu", clientPayload: { connectionId: "c", stunServer: "stun:test" } },
  } as const;
}
