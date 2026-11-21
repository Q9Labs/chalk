import { afterEach, expect, it, vi } from "vitest";
import { problemReporter } from "./problem-reports";

afterEach(() => vi.unstubAllGlobals());

async function sentDiagnostics(diagnostics: string | undefined): Promise<string | undefined> {
  let sentBody: unknown;
  vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
    sentBody = init?.body;
    return new Response("{}", { status: 201 });
  });
  const sync = { stage: "hello", opened: true, closeCode: null, closeReason: null, durationMs: 4000 } as const;
  const report = problemReporter({
    baseURL: "https://api.example.test",
    tenantId: "tnt_1",
    mediaProof: () => "proof",
    connection: () => ({ status: "failed", lastError: { code: "connection.sync_hello_timeout", recoverable: true, message: "x", sync } }),
  });
  await report({ description: "It dropped", diagnostics });
  return (JSON.parse(String(sentBody)) as { diagnostics?: string }).diagnostics;
}

it("always sends the error code and sync detail, even when the person left diagnostics off", async () => {
  const sent = await sentDiagnostics(undefined);
  expect(sent).toMatch(/^Error: connection\.sync_hello_timeout \[hello; open=1;/);
  expect(sent).not.toContain("Browser:");
});

it("adds the rest of the diagnostics after the error line when the person includes them", async () => {
  const sent = await sentDiagnostics("Call: x");
  expect(sent?.split("\n")[0]).toMatch(/^Error: connection\.sync_hello_timeout/);
  expect(sent).toContain("Connection: failed");
  expect(sent).toContain("Browser:");
});
