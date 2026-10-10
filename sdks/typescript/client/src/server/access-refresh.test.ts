import { describe, expect, it, vi } from "vitest";
import { accessGrantFromParsed } from "../access/grant.js";
import { accessGrant } from "../access/grant.test.helpers.js";
import { getAccessRefreshState } from "./access-refresh.js";
import { createChalkServerClient } from "./client.js";

describe("server-only Access refresh state", () => {
  it("refreshes the same Participant and media connection, retaining each new credential", async () => {
    const initial = accessGrantFromParsed(accessGrant(Date.now() + 60_000, "initial"));
    const renewed = accessGrantFromParsed(accessGrant(Date.now() + 120_000, "renewed"));
    const requests: { url: string; body: string }[] = [];
    const client = createChalkServerClient({
      apiKey: "server-secret",
      tenantId: "tenant-1",
      apiBaseURL: "https://api.chalk.test",
      fetch: async (url, init) => {
        requests.push({ url: String(url), body: String(init?.body) });
        return Response.json(renewed, { status: 201 });
      },
    });
    const retained = getAccessRefreshState(initial);
    const next = await client.participants.issueAccess("space-1", "episode-1", "participant-1", retained);
    expect(requests).toEqual([{ url: "https://api.chalk.test/v1/tenants/tenant-1/spaces/space-1/episodes/episode-1/participants/participant-1/access-grant", body: JSON.stringify({ participant_generation: 1, replace_media_connection: false, current_media_token: retained.currentMediaToken }) }]);
    expect(getAccessRefreshState(next).participantGeneration).toBe(1);
    expect(getAccessRefreshState(next).currentMediaToken).not.toBe(retained.currentMediaToken);
    expect(Object.isFrozen(retained)).toBe(true);
  });
  it.each(["refresh", "retry"] as const)("retains media for a forwarded %s request", async (reason) => {
    const initial = accessGrantFromParsed(accessGrant(Date.now() + 60_000, "initial"));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(initial, { status: 201 }));
    const client = createChalkServerClient({ apiKey: "server-secret", tenantId: "tenant-1", apiBaseURL: "https://api.chalk.test", fetch });
    const state = getAccessRefreshState(initial);
    const request = { space: "space-1", reason, replaceMediaConnection: false };
    await client.participants.issueAccess("space-1", "episode-1", "participant-1", state, request);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ participant_generation: 1, replace_media_connection: false, current_media_token: state.currentMediaToken });
  });

  it("replaces media for a forwarded recovery request without sending the old credential", async () => {
    const initial = accessGrantFromParsed(accessGrant(Date.now() + 60_000, "initial"));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(initial, { status: 201 }));
    const client = createChalkServerClient({ apiKey: "server-secret", tenantId: "tenant-1", apiBaseURL: "https://api.chalk.test", fetch });
    const state = getAccessRefreshState(initial);
    const request = { space: "space-1", reason: "retry", replaceMediaConnection: true };
    await client.participants.issueAccess("space-1", "episode-1", "participant-1", state, request);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ participant_generation: 1, replace_media_connection: true });
    expect(getAccessRefreshState(initial)).toEqual(state);
  });

  it("does not retry a replacement requested through the forwarded context", async () => {
    const initial = accessGrantFromParsed(accessGrant(Date.now() + 60_000, "initial"));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: { code: "unavailable", message: "Unavailable" } }, { status: 503 }));
    const client = createChalkServerClient({ apiKey: "server-secret", tenantId: "tenant-1", apiBaseURL: "https://api.chalk.test", fetch });
    await expect(client.participants.issueAccess("space-1", "episode-1", "participant-1", getAccessRefreshState(initial), { replaceMediaConnection: true })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
