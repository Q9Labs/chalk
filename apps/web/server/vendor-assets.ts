export default {
  async fetch(request: Request, env: { VENDOR_ASSETS: R2Bucket }) {
    const path = new URL(request.url).pathname;
    // Legacy, non-digest paths remain static Pages assets, including on native rollbacks.
    if (!/^\/chalk-(?:whiteboard|mathjax)\/[a-zA-Z0-9.+-]+-[0-9a-f]{16}(?:\/|$)/.test(path)) return fetch(request);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    let key: string;
    try {
      key = decodeURIComponent(path.slice(1));
    } catch {
      return new Response("Invalid path", { status: 400 });
    }
    const object = await env.VENDOR_ASSETS.get(key);
    if (!object) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("Content-Length", String(object.size));
    headers.set("ETag", object.httpEtag);
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(request.method === "HEAD" ? null : object.body, { headers });
  },
};
