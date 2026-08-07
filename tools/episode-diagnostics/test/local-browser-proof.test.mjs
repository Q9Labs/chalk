import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { assertPort, availableLoopbackPort, waitForPortClosed } from "../src/local-browser-proof.mjs";

describe("local browser proof supervisor", () => {
  let server;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    server = undefined;
  });

  it("allocates loopback ports and rejects unsafe values", async () => {
    const port = await availableLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(() => assertPort(0, "port")).toThrow(/valid TCP port/u);
    expect(() => assertPort(65_536, "port")).toThrow(/valid TCP port/u);
  });

  it("proves a listener is gone after the server closes", async () => {
    server = createServer((_request, response) => response.end("ok"));
    await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve()));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
    await expect(waitForPortClosed(origin, 500)).resolves.toBeUndefined();
  });
});
