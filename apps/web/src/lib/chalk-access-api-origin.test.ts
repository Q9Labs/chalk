import { afterEach, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { opaqueAccessGrant } from "../../../../sdks/typescript/client/src/space-client/core.test.helpers";
import { reloadRejoinAccess, type PublicSpaceArrival } from "@q9labsai/chalk-client";
import { createPreparedPublicSpace, createPublicInviteClient, type PublicInviteClient, publicAPIBaseURL } from "./chalk-access";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("keeps call access and reporting on the same-origin dev proxy without VITE_API_URL", () => {
  vi.stubEnv("VITE_API_URL", "");
  vi.stubGlobal("location", { origin: "http://127.0.0.1:3070" });
  expect(publicAPIBaseURL()).toBe("http://127.0.0.1:3070");
});

it("uses the explicitly configured call API instead of the web origin", () => {
  vi.stubEnv("VITE_API_URL", " https://api.chalk.test ");
  vi.stubGlobal("location", { origin: "http://127.0.0.1:3070" });
  expect(publicAPIBaseURL()).toBe("https://api.chalk.test");
});

it("notifies report subscribers of renewed access and stops after unsubscribe", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-24T11:00:00Z"));
  const access = opaqueAccessGrant(1);
  const arrival: PublicSpaceArrival = { state: "admitted", arrival_handle: "arrival-1", space: { admission_mode: "open", name: "Test call", slug: "test-call" }, access };
  clock.mockReturnValue(Date.parse("2026-10-24T11:05:00Z"));
  const renewed = opaqueAccessGrant(2);
  const unused = async () => {
    throw new Error("Unexpected client operation");
  };
  const client: PublicInviteClient = {
    prepareSpaceEntrance: unused,
    createPublicSpace: unused,
    arriveBySpacePublicInvite: unused,
    getSpacePublicInviteArrival: unused,
    leaveSpacePublicInviteArrival: unused,
    refreshSpacePublicInviteAccess: vi.fn().mockResolvedValue(renewed),
  };
  const prepared = createPreparedPublicSpace(client, arrival);
  const changed = vi.fn(() => ({ credential: prepared.reportCredential(), expiresAt: prepared.reportCredentialExpiresAt() }));
  const unsubscribe = prepared.subscribe(changed);
  await prepared.getAccess({ space: "test-call", reason: "join", replaceMediaConnection: false });
  expect(changed).not.toHaveBeenCalled();
  await prepared.getAccess({ space: "test-call", reason: "refresh", replaceMediaConnection: false });
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.results[0]?.value).toEqual({ credential: reloadRejoinAccess(renewed).mediaProof, expiresAt: Date.parse("2026-10-24T11:10:00Z") });
  unsubscribe();
  await prepared.getAccess({ space: "test-call", reason: "refresh", replaceMediaConnection: false });
  expect(changed).toHaveBeenCalledTimes(1);
});

it.each(["not-date", "2026-02-30T01:00:00Z", "2026-10-29T01:00:00+04:00"])("preserves the report-expiry validation error for %s", (expires_at) => {
  const access = opaqueAccessGrant(1);
  Object.assign(access, { media: { token: reloadRejoinAccess(access).mediaProof, expires_at } });
  const arrival: PublicSpaceArrival = { state: "admitted", arrival_handle: "arrival-1", space: { admission_mode: "open", name: "Test call", slug: "test-call" }, access };
  const prepared = createPreparedPublicSpace(createPublicInviteClient(), arrival);
  expect(() => prepared.reportCredentialExpiresAt()).toThrow(ZodError);
});
