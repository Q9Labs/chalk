import { describe, expect, it } from "vitest";
import { decodeServerSentEvents, SERVER_SENT_EVENT_LIMITS, ServerSentEventLimitError } from "./sse";

const chunks = async function* (values: string[]) {
  const encoder = new TextEncoder();
  for (const value of values) yield encoder.encode(value);
};

describe("decodeServerSentEvents", () => {
  it("decodes fields split across arbitrary chunks", async () => {
    const decoded = [];
    for await (const message of decodeServerSentEvents(chunks(["id: 4\r\nevent: del", 'ta\r\ndata: {"cursor":', "4}\r\n\r\n"]))) {
      decoded.push(message);
    }

    expect(decoded).toEqual([{ id: "4", event: "delta", data: '{"cursor":4}' }]);
  });

  it("joins multiline data and preserves the last Event ID", async () => {
    const decoded = [];
    for await (const message of decodeServerSentEvents(chunks(["id: 9\ndata: first\ndata: second\n\n", "data: next\n\n"]))) {
      decoded.push(message);
    }

    expect(decoded).toEqual([
      { id: "9", data: "first\nsecond" },
      { id: "9", data: "next" },
    ]);
  });

  it("ignores heartbeat comments and invalid retry fields", async () => {
    const decoded = [];
    for await (const message of decodeServerSentEvents(chunks([": heartbeat\nretry: later\n\n", "retry: 250\ndata: ready\n\n"]))) {
      decoded.push(message);
    }

    expect(decoded).toEqual([{ data: "ready", retry: 250 }]);
  });

  it("rejects an oversized partial line and cancels the reader", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(SERVER_SENT_EVENT_LIMITS.maxPartialLineBytes + 1)));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(async () => {
      for await (const _message of decodeServerSentEvents(stream)) void _message;
    }).rejects.toBeInstanceOf(ServerSentEventLimitError);
    expect(cancelled).toBe(true);
  });

  it("rejects oversized accumulated data across multiple SSE lines", async () => {
    const line = "a".repeat(45 * 1024);

    await expect(async () => {
      for await (const _message of decodeServerSentEvents(chunks([`data: ${line}\n`, `data: ${line}\n`, `data: ${line}\n\n`]))) void _message;
    }).rejects.toMatchObject({ name: "ServerSentEventLimitError", scope: "data" });
  });

  it("rejects oversized accumulated event metadata", async () => {
    const line = "event: " + "a".repeat(60 * 1024);

    await expect(async () => {
      for await (const _message of decodeServerSentEvents(chunks([`${line}\n`, `${line}\n`, `${line}\n`, `${line}\n`, `${line}\n`, `data: ready\n\n`]))) void _message;
    }).rejects.toMatchObject({ name: "ServerSentEventLimitError", scope: "event" });
  });
});
