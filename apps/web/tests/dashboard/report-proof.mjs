import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, open, writeFile } from "node:fs/promises";

import { createDiscordProofTransport } from "./report-discord-transport.mjs";

const reports = [];
const liveURL = process.env.CHALK_REPORT_LIVE_WEBHOOK_URL;
const live = process.env.CHALK_REPORT_LIVE_PROOF === "1";
assert(!live || (liveURL && process.env.CHALK_REPORT_LIVE_ONCE_FILE), "Live proof needs an injected secret and a durable once marker");
let liveSent = false;
let failDelivery = false;
const server = createServer(async (request, response) => {
  if (request.url === "/reports" && request.method === "GET") return response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(reports));
  if (request.url === "/fail" && request.method === "POST") {
    failDelivery = true;
    return response.writeHead(204).end();
  }
  if (request.url === "/recover" && request.method === "POST") {
    failDelivery = false;
    return response.writeHead(204).end();
  }
  if (request.method !== "POST") return response.writeHead(404).end();
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    await new Promise((accept) => setTimeout(accept, 150));
    if (failDelivery) return response.writeHead(500).end();
    reports.push(payload);
    if (live) {
      assert(!liveSent, "Refusing a second live Discord message");
      assert(payload.content.includes("TEST from Chalk report-discord PR, ignore"));
      const marker = await open(process.env.CHALK_REPORT_LIVE_ONCE_FILE, "wx", 0o600);
      await marker.close();
      liveSent = true;
      const url = new URL(liveURL);
      url.searchParams.set("wait", "true");
      const delivery = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
      assert.equal(delivery.status, 200, "Discord acknowledgement");
      const message = await delivery.json();
      assert(message.id && message.content === payload.content, "Discord must return the created report");
      const verification = await fetch(`${url.origin}${url.pathname}/messages/${message.id}`, { signal: AbortSignal.timeout(8000) });
      assert.equal(verification.status, 200, "Read back the delivered Discord message");
      assert.equal((await verification.json()).content, payload.content);
      await mkdir("artifacts/report-discord", { recursive: true });
      await writeFile("artifacts/report-discord/discord-ack.json", JSON.stringify({ result: "passed", messages: 1, messageId: message.id, confirmedBy: "Discord wait=true response and message GET" }));
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end('{"id":"fixture-message"}');
  } catch {
    // Do not expose a transport error or URL from the secret-bearing fetch.
    response.writeHead(502).end("Discord proof failed");
  }
});
const transport = await createDiscordProofTransport((request, response) => server.emit("request", request, response));
try {
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(Number(process.env.CHALK_REPORT_FAKE_PORT ?? 18082), "127.0.0.1", accept);
  });
} catch (error) {
  await transport.close();
  throw error;
}
const env = {
  CHALK_API_CORS_ALLOWED_ORIGINS: `http://127.0.0.1:${process.env.CHALK_DASHBOARD_WEB_PORT ?? 18797}`,
  ...process.env,
  ...transport.env,
  CHALK_REPORT_PROOF: "1",
  CHALK_REPORT_FAKE_ORIGIN: `http://127.0.0.1:${server.address().port}`,
  CHALK_PROBLEM_REPORTS_DISCORD_WEBHOOK_URL: live ? liveURL : "https://discord.com/api/webhooks/proof/fake",
  DASHBOARD_ENGINE_DEADLINE_SECONDS: "900",
};
delete env.CHALK_REPORT_LIVE_WEBHOOK_URL;
const child = spawn("bash", ["apps/web/tests/dashboard/real-engine.sh", "node", "apps/web/tests/dashboard/join-browser.mjs"], { env, detached: true, stdio: "inherit" });
const stop = () => {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
const owner = process.ppid;
const watchdog = setInterval(() => {
  try {
    process.kill(owner, 0);
  } catch {
    stop();
  }
}, 1000);
const deadline = setTimeout(stop, 15 * 60_000);
try {
  const [code] = await once(child, "exit");
  assert.equal(code, 0, "Real-stack report browser proof");
  if (live) assert(liveSent && reports.length === 1, "Exactly one live message");
} finally {
  clearInterval(watchdog);
  clearTimeout(deadline);
  stop();
  await transport.close();
  server.closeAllConnections();
  await new Promise((accept) => server.close(accept));
}
