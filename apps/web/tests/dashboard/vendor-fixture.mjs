import { createServer } from "node:http";
import { readFileSync } from "node:fs";

// The historical-artifact tests serve a fixture object instead of calling R2.
const server = createServer((request, response) => {
  request.resume();
  if (request.method === "GET" && request.url === "/healthz") return response.writeHead(200).end();
  if (request.method === "GET" && new URL(request.url, "http://localhost").pathname.endsWith("/transcript.json")) {
    const body = readFileSync("artifacts/dashboard-transcript.json");
    return response.writeHead(200, { "Content-Type": "application/json", "Content-Length": body.length }).end(body);
  }
  response.writeHead(404).end();
});
server.listen(Number(process.env.CHALK_DASHBOARD_VENDOR_PORT || 18081), "127.0.0.1");
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
