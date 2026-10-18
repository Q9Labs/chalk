import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// Only the external Cloudflare allocation is simulated. Never emulate engine
// routes: authorization, Participants and signed grants use the real API.
const server = createServer((request, response) => {
  request.resume();
  if (request.method === "GET" && request.url === "/healthz") return response.writeHead(200).end();
  if (request.method === "GET" && new URL(request.url, "http://localhost").pathname.endsWith("/transcript.json")) {
    const body = readFileSync("artifacts/dashboard-transcript.json");
    return response.writeHead(200, { "Content-Type": "application/json", "Content-Length": body.length }).end(body);
  }
  if (request.method !== "POST" || request.url !== "/apps/dashboard-proof/sessions/new") return response.writeHead(404).end();
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ sessionId: randomUUID() }));
});
server.listen(18081, "127.0.0.1");
const owner = Number(process.argv[2]);
const watchdog = setInterval(() => {
  try {
    process.kill(owner, 0);
  } catch {
    server.close();
    clearInterval(watchdog);
  }
}, 1000);
const deadline = setTimeout(() => {
  server.close();
  clearInterval(watchdog);
}, 240000);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    clearInterval(watchdog);
    clearTimeout(deadline);
    server.close();
  });
