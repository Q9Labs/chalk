import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readBoundedNodeBody } from "./node-request-body";

describe("bounded Node request body", () => {
  it("joins chunks without changing their bytes", async () => {
    const body = await readBoundedNodeBody(requestFrom(["chalk", " dashboard"]), 64, "too large");
    expect(new TextDecoder().decode(body)).toBe("chalk dashboard");
  });

  it("rejects a body above the configured boundary", async () => {
    await expect(readBoundedNodeBody(requestFrom(["1234", "5678"]), 7, "too large")).rejects.toThrow("too large");
  });
});

function requestFrom(chunks: string[]): IncomingMessage {
  return Readable.from(chunks) as IncomingMessage;
}
