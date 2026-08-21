import { describe, expect, it, vi } from "vitest";
import { createChalkServerClient } from "./client";

const tenantId = "11111111-1111-4111-8111-111111111111";
const spaceId = "22222222-2222-4222-8222-222222222222";
const requestHandle = "request_handle_123456";

describe("server public Space invite APIs", () => {
  it("uses the management routes, exact bodies, authorization, and idempotency headers", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      const url = String(input);
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/public-invite")) return Response.json(invite(), { status: init?.method === "PATCH" ? 200 : 200 });
      if (pathname.endsWith("/rotations")) return Response.json(invite(), { status: 201 });
      if (pathname.endsWith("/public-admission-requests")) return Response.json({ requests: [request()] }, { status: 200 });
      return Response.json(request(), { status: 200 });
    });
    const client = createChalkServerClient({ apiBaseURL: "https://api.chalk.test", apiKey: "chalk_sk_secret.value", tenantId, fetch });

    await expect(client.publicInvites.get(spaceId)).resolves.toMatchObject({ enabled: true });
    await expect(client.publicInvites.update(spaceId, { enabled: false })).resolves.toMatchObject({ enabled: true });
    await expect(client.publicInvites.rotate(spaceId, { idempotencyKey: "rotate-public-0" })).resolves.toMatchObject({ generation: 2 });
    await expect(client.publicAdmissionRequests.list(spaceId, { state: "pending" })).resolves.toMatchObject({ requests: [{ state: "pending" }] });
    await expect(client.publicAdmissionRequests.approve(spaceId, requestHandle, { idempotencyKey: "approve-public-0" })).resolves.toMatchObject({ request_handle: requestHandle });
    await expect(client.publicAdmissionRequests.deny(spaceId, requestHandle, { idempotencyKey: "deny-public-0" })).resolves.toMatchObject({ request_handle: requestHandle });

    expect(requests.map(({ input }) => String(input))).toEqual([
      `https://api.chalk.test/v1/tenants/${tenantId}/spaces/${spaceId}/public-invite`,
      `https://api.chalk.test/v1/tenants/${tenantId}/spaces/${spaceId}/public-invite`,
      `https://api.chalk.test/v1/tenants/${tenantId}/spaces/${spaceId}/public-invite/rotations`,
      `https://api.chalk.test/v1/tenants/${tenantId}/spaces/${spaceId}/public-admission-requests?state=pending`,
      `https://api.chalk.test/v1/tenants/${tenantId}/spaces/${spaceId}/public-admission-requests/${requestHandle}/approval`,
      `https://api.chalk.test/v1/tenants/${tenantId}/spaces/${spaceId}/public-admission-requests/${requestHandle}/denial`,
    ]);
    expect(requests.map(({ init }) => init?.method)).toEqual(["GET", "PATCH", "POST", "GET", "POST", "POST"]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ enabled: false });
    expect(new Headers(requests[2]?.init?.headers).get("idempotency-key")).toBe("rotate-public-0");
    expect(new Headers(requests[4]?.init?.headers).get("idempotency-key")).toBe("approve-public-0");
    expect(new Headers(requests[5]?.init?.headers).get("idempotency-key")).toBe("deny-public-0");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer chalk_sk_secret.value");
  });
});

function invite() {
  return {
    admission_mode: "open",
    canonical_url: "/space/space#spaceInviteToken=cspi1.token.payload.signature",
    created_at: "2026-08-19T00:00:00Z",
    enabled: true,
    generation: 2,
    public_role: "collaborator",
    schema_version: "cspi1",
    space_id: spaceId,
    tenant_id: tenantId,
    updated_at: "2026-08-19T00:00:00Z",
  };
}

function request() {
  return {
    display_name: "Ada",
    expires_at: "2026-08-19T01:00:00Z",
    request_handle: requestHandle,
    requested_at: "2026-08-19T00:00:00Z",
    state: "pending",
  };
}
