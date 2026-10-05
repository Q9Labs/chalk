import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { forceAndWaitForRecovery } from "./recovery.mjs";

const { chromium } = createRequire(new URL("../../../sdks/typescript/client/package.json", import.meta.url))("playwright");
const { WebSocketServer } = createRequire(new URL("../package.json", import.meta.url))("ws");

test("a real browser recovers through a failed replacement handshake while staying live", { timeout: 15_000 }, async () => {
  const server = createServer((_request, response) => response.end("<!doctype html><title>Recovery fixture</title>"));
  const sockets = new WebSocketServer({ noServer: true });
  let attempts = 0;
  server.on("upgrade", (request, socket, head) => {
    attempts += 1;
    if (attempts === 1) return socket.destroy();
    sockets.handleUpgrade(request, socket, head, (replacement) => replacement.send("replacement frame"));
  });
  let browser;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseURL = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    await page.goto(baseURL);
    await forceAndWaitForRecovery(
      page,
      `${baseURL}/test/force-media`,
      async () => {
        await page.evaluate(async () => {
          const url = `ws://${location.host}/media`;
          await new Promise((resolve, reject) => {
            const first = new WebSocket(url);
            const timer = setTimeout(() => reject(new Error("Expected handshake failure")), 4_000);
            first.onerror = () => {
              clearTimeout(timer);
              new WebSocket(url);
              resolve();
            };
          });
        });
      },
      async (_page, predicate) => assert.equal(predicate({ state: "live" }), true),
    );
    assert.equal(attempts, 2);
  } finally {
    await browser?.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});
