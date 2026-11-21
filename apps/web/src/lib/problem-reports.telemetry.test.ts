// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { problemReporter } from "./problem-reports";

const connection = () => ({ status: "live", lastError: null });
const stored = () => new Response(JSON.stringify({ sent: true, report_id: "report-1", code: "CHK-9F3D" }), { status: 200, headers: { "content-type": "application/json" } });

function reporter(answer: () => Promise<Response> | Response, telemetry?: { sessionId: string; sdkVersion: string; problemReported: (report?: unknown) => void }) {
  vi.stubGlobal("__APP_VERSION__", "test");
  const calls: { url: string; body: string; method: string | undefined }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body), method: init.method });
    return answer();
  });
  const send = problemReporter({ baseURL: "https://api.example.test", tenantId: "tenant-1", mediaProof: () => "proof", connection, telemetry });
  return { send, calls };
}

afterEach(() => vi.unstubAllGlobals());

it("sends journey, symptom, client session and sdk version, then reports the code back", async () => {
  let reported: unknown;
  const { send, calls } = reporter(stored, { sessionId: "client-session-1", sdkVersion: "5.5.0", problemReported: (report) => (reported = report) });
  const result = await send({ description: "No sound", diagnostics: "", pickedSymptom: "audio.not_heard" });
  const body = JSON.parse(calls[0]?.body ?? "{}");
  expect(body.picked_symptom).toBe("audio.not_heard");
  expect(body.client_session_id).toBe("client-session-1");
  expect(body.sdk_version).toBe("5.5.0");
  expect(body.journey_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(String(body.diagnostics)).toContain("Client session: client-session-1");
  expect(reported).toMatchObject({ journeyId: body.journey_id, reportId: "report-1", code: "CHK-9F3D", pickedSymptom: "audio.not_heard" });
  expect(result).toMatchObject({ code: "CHK-9F3D", journeyId: body.journey_id });
});

it("does not tell telemetry about a report the server refused, and the error carries the journey", async () => {
  let reported = 0;
  const { send } = reporter(() => new Response(null, { status: 500 }), { sessionId: "client-session-1", sdkVersion: "5.5.0", problemReported: () => (reported += 1) });
  await expect(send({ description: "No sound", diagnostics: "" })).rejects.toMatchObject({ classification: { outcome: "error", code: "report.send_refused" }, journeyId: expect.any(String) });
  expect(reported).toBe(0);
});

it("leaves picked_symptom unavailable when the picker was never touched", async () => {
  const { send, calls } = reporter(stored, { sessionId: "client-session-1", sdkVersion: "5.5.0", problemReported: () => undefined });
  await send({ description: "No sound", diagnostics: "" });
  expect(JSON.parse(calls[0]?.body ?? "{}").picked_symptom).toBe("unavailable(not_picked)");
});
