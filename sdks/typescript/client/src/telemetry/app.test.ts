import { describe, expect, it } from "vitest";
import { appTelemetry } from "./app";
import { createTestOutbox } from "./outbox.test.helpers";

describe("app telemetry", () => {
  it("sends a problem report at once and carries the client session id", async () => {
    const test = createTestOutbox();
    const app = appTelemetry(test.outbox);
    app.problemReported();
    await test.outbox.flush();
    expect(app.sessionId).toBe(test.outbox.clientSessionId);
    expect(test.accepted.map((event) => event.type)).toEqual(["problem_reported"]);
  });

  it("sends a render crash with its cause as a kernel record", async () => {
    const test = createTestOutbox();
    appTelemetry(test.outbox).renderCrashed("chunk_reload");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await test.outbox.flush();
    expect(test.accepted.map((event) => ("name" in event ? { name: event.name, render_cause: event.render_cause } : { name: event.type }))).toEqual([{ name: "client.render_crashed", render_cause: "chunk_reload" }]);
  });
});
