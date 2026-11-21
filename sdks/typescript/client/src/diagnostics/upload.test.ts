import { describe, expect, it } from "vitest";
import { createKernel, type Kernel, type ObsRecord } from "../obs/kernel";
import { uploadDiagnosticBundle, type DiagnosticUploadRequest } from "./upload";

function kernel(): { obs: Kernel; records: ObsRecord[] } {
  const records: ObsRecord[] = [];
  let next = 0;
  return {
    records,
    obs: createKernel({
      mode: "closed",
      sink: (record) => records.push(record),
      build: { module: "sdk", env: "test", platform: "web" },
      trail: () => ({ client_session_id: "cs_1" }),
      uuid: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
      now: () => 1_800_000_000_000,
    }),
  };
}

const issued = {
  upload_id: "dg_1",
  url: "https://r2.example.test/bundle-1?signature=x",
  headers: { "x-amz-content-sha256": ["UNSIGNED-PAYLOAD"] },
  expires_at: "2026-11-21T12:00:00Z",
};

type Call = { readonly url: string; readonly method: string | undefined; readonly body: unknown; readonly headers: Record<string, string> };

function harness(answers: (Response | (() => Response))[], extra: { readonly isHidden?: () => boolean } = {}) {
  const calls: Call[] = [];
  const { obs, records } = kernel();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const answer = answers[calls.length];
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
    calls.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(typeof init.body === "string" ? init.body : "{}") : undefined, headers });
    if (!answer) throw new Error(`unexpected fetch ${calls.length}`);
    return typeof answer === "function" ? answer() : answer;
  };
  const options = {
    apiBaseURL: "https://api.example.test",
    tenantId: "tenant-1",
    credential: "media-token",
    bundle: async () => new Uint8Array([0x1f, 0x8b, 1]),
    obs,
    fetch,
    sha256: async () => "ab".repeat(32),
    isHidden: () => false,
    ...extra,
  };
  return { calls, records, options };
}

const report: DiagnosticUploadRequest = { trigger: "report", reportId: "report-1" };

describe("uploadDiagnosticBundle", () => {
  it("issues, puts the bundle, completes, and records ok once", async () => {
    const { calls, records, options } = harness([Response.json(issued), new Response(null, { status: 200 }), Response.json({ stored: true })]);
    await expect(uploadDiagnosticBundle({ ...options, request: report })).resolves.toMatchObject({ uploadId: "dg_1", bytes: 3 });
    expect(calls.map((call) => call.method)).toEqual(["POST", "PUT", "POST"]);
    expect(calls[0]).toMatchObject({ url: "https://api.example.test/v1/tenants/tenant-1/diagnostic-uploads" });
    expect(calls[0]?.body).toEqual({ trigger: "report", report_id: "report-1" });
    expect(calls[0]?.headers["authorization"]).toBe("Bearer media-token");
    expect(calls[1]?.url).toBe(issued.url);
    expect(calls[1]?.headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    expect(calls[2]).toMatchObject({ url: "https://api.example.test/v1/tenants/tenant-1/diagnostic-uploads/dg_1/complete", body: { bytes: 3, sha256: "ab".repeat(32) } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "op", name: "report.upload", outcome: "ok", upload_trigger: "report", report_id: "report-1", diagnostic_upload_id: "dg_1", http_status: 200, bytes: 3 });
  });

  it("names the live request target", async () => {
    const { calls, records, options } = harness([Response.json(issued), new Response(null, { status: 200 }), Response.json({ stored: true })]);
    await uploadDiagnosticBundle({ ...options, request: { trigger: "live", liveRequestId: "live-1" } });
    expect(calls[0]?.body).toEqual({ trigger: "live", live_request_id: "live-1" });
    expect(records[0]).toMatchObject({ upload_trigger: "live", live_request_id: "live-1" });
    expect(records[0]).not.toHaveProperty("report_id");
  });

  it("refused issue records error(report.upload_refused) with its status", async () => {
    const { calls, records, options } = harness([new Response(null, { status: 409 })]);
    await expect(uploadDiagnosticBundle({ ...options, request: report })).rejects.toThrow("upload_refused");
    expect(calls).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "error", reason_code: "report.upload_refused", diagnostic_upload_id: "unavailable(not_issued)" });
  });

  it("a dropped network records error(report.network)", async () => {
    const { records, options } = harness([() => Response.json(issued), () => new Response(null, { status: 200 })]);
    const failing = { ...options, fetch: (() => Promise.reject(new TypeError("offline"))) as typeof globalThis.fetch };
    // The op rethrows the cause; the record holds the classification.
    await expect(uploadDiagnosticBundle({ ...failing, request: report })).rejects.toThrow("offline");
    expect(records[0]).toMatchObject({ outcome: "error", reason_code: "report.network" });
  });

  it("a missing credential records error(report.no_credential) before any request", async () => {
    const { calls, records, options } = harness([]);
    await expect(uploadDiagnosticBundle({ ...options, credential: () => undefined, request: report })).rejects.toThrow("no_credential");
    expect(calls).toHaveLength(0);
    expect(records[0]).toMatchObject({ outcome: "error", reason_code: "report.no_credential" });
  });

  it("a page hide after issue records expected(report.page_hidden)", async () => {
    const { calls, records, options } = harness([Response.json(issued), new Response(null, { status: 200 }), Response.json({ stored: true })]);
    // The check runs after each API response; once the first lands, calls.length is 1.
    await expect(uploadDiagnosticBundle({ ...options, isHidden: () => calls.length >= 1, request: report })).rejects.toThrow("page_hidden");
    expect(calls).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "expected", reason_code: "report.page_hidden" });
  });

  it("a refused PUT records error(report.upload_refused)", async () => {
    const { calls, records, options } = harness([Response.json(issued), new Response(null, { status: 403 })]);
    await expect(uploadDiagnosticBundle({ ...options, request: report })).rejects.toThrow("upload_refused");
    expect(calls).toHaveLength(2);
    expect(records[0]).toMatchObject({ outcome: "error", reason_code: "report.upload_refused", http_status: 403 });
  });

  it("works without an obs kernel and still runs the lifecycle", async () => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      calls.push(init?.method ?? "?");
      return calls.length === 1 ? Response.json(issued) : calls.length === 2 ? new Response(null, { status: 200 }) : Response.json({ stored: true });
    };
    await expect(
      uploadDiagnosticBundle({
        apiBaseURL: "https://api.example.test",
        tenantId: "tenant-1",
        credential: "media-token",
        request: report,
        bundle: async () => new Uint8Array([1]),
        fetch,
        sha256: async () => "ab".repeat(32),
      }),
    ).resolves.toMatchObject({ uploadId: "dg_1" });
    expect(calls).toEqual(["POST", "PUT", "POST"]);
  });
});
