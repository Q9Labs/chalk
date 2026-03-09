import { describe, expect, it, vi } from "bun:test";
import { createHttpIncidentReporter, createSupportCode, type ChalkIncident } from "../incident.ts";

const incidentFixture: ChalkIncident = {
  id: "CHK-20260302-101010-001",
  timestamp: "2026-03-02T10:10:10.000Z",
  severity: "error",
  source: "session",
  message: "Failed to fetch",
  code: "CONNECTION_FAILED",
  roomId: "room-123",
  traceId: "trace-123",
};

describe("incident utilities", () => {
  it("generates stable support code format", () => {
    const code = createSupportCode(1, new Date("2026-03-02T10:10:10.000Z"));
    expect(code).toBe("CHK-20260302-101010-001");
  });

  it("posts incident payload via HTTP reporter", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200, statusText: "OK" }));
    const reporter = createHttpIncidentReporter({
      endpoint: "https://example.com/incident",
      fetchImpl,
      retries: 0,
    });

    await reporter(incidentFixture);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://example.com/incident");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual(expect.objectContaining({ "content-type": "application/json" }));
    expect(String(init?.body)).toContain("CHK-20260302-101010-001");
  });

  it("retries failed HTTP reporter requests", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const reporter = createHttpIncidentReporter({
      endpoint: "https://example.com/incident",
      fetchImpl,
      retries: 1,
      retryDelayMs: 0,
    });

    await reporter(incidentFixture);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws when reporter exhausts all retries", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    const reporter = createHttpIncidentReporter({
      endpoint: "https://example.com/incident",
      fetchImpl,
      retries: 1,
      retryDelayMs: 0,
    });

    await expect(reporter(incidentFixture)).rejects.toThrow("incident reporter request failed: 500");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
