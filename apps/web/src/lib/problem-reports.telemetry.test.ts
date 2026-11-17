// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { problemReporter } from "./problem-reports";

const connection = () => ({ status: "live", lastError: null });

function reporter(answer: Response, telemetry: { sessionId: string; problemReported: () => void }) {
  vi.stubGlobal("__APP_VERSION__", "test");
  const bodies: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return answer;
  });
  return { send: problemReporter({ baseURL: "https://api.example.test", tenantId: "tenant-1", mediaProof: () => "proof", connection, telemetry }), bodies };
}

afterEach(() => vi.unstubAllGlobals());

it("names the client session in the report and tells telemetry once the report is sent", async () => {
  let reported = 0;
  const { send, bodies } = reporter(new Response(null, { status: 201 }), { sessionId: "client-session-1", problemReported: () => (reported += 1) });
  await send({ description: "No sound", diagnostics: "" });
  expect(reported).toBe(1);
  expect(String(JSON.parse(bodies[0] ?? "{}").diagnostics)).toContain("Client session: client-session-1");
});

it("does not tell telemetry about a report the server refused", async () => {
  let reported = 0;
  const { send } = reporter(new Response(null, { status: 500 }), { sessionId: "client-session-1", problemReported: () => (reported += 1) });
  await expect(send({ description: "No sound", diagnostics: "" })).rejects.toThrow("could not be sent");
  expect(reported).toBe(0);
});
