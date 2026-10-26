// A bounded, unauthenticated transport control. No proxy, storage or call access.
const headers = {
  "Access-Control-Allow-Origin": "https://qa.q9labs.ai",
  "Access-Control-Expose-Headers": "CF-Ray",
  "Timing-Allow-Origin": "https://qa.q9labs.ai",
  "Cache-Control": "no-store",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ping" && request.method === "GET") return new Response("ok", { headers });
    if (url.pathname !== "/ws" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Not found", { status: 404, headers });
    if (request.headers.get("Origin") !== "https://qa.q9labs.ai") return new Response("Origin not allowed", { status: 403, headers });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const timer = setTimeout(() => server.close(1000, "qa control complete"), 2000);
    server.addEventListener("message", () => server.close(1008, "no messages expected"));
    server.addEventListener("close", () => clearTimeout(timer));
    return new Response(null, { status: 101, webSocket: client });
  },
};
