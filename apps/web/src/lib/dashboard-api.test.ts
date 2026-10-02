// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { DashboardAPIError, getAccount } from "./dashboard-api";

afterEach(() => vi.unstubAllGlobals());

it("names the endpoint and failing field when a response breaks the contract, without echoing values", async () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => (String(input).includes("csrf") ? json({ csrf_token: "token", expires_at: "2099-01-01T00:00:00Z" }) : json({ user: { id: "private-value" } }))),
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const failure = await getAccount().catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(DashboardAPIError);
  expect(failure).toMatchObject({ message: "Response did not match the expected contract" });
  expect(warn).toHaveBeenCalledTimes(1);
  const [, detail] = warn.mock.calls[0] ?? [];
  expect(detail).toMatchObject({ endpoint: "GET /api/me", status: 200, failing_path: expect.stringMatching(/\w/) });
  expect(detail).not.toMatchObject({ failing_path: "unknown" });
  expect(JSON.stringify(detail)).not.toContain("private-value");
  warn.mockRestore();
});
