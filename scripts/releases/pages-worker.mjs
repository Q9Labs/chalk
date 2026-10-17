const apiOrigins = new Map([
  ["nightly", "https://nightly-api.chalkmeet.com"],
  ["production", "https://api.chalkmeet.com"],
]);

export default {
  async fetch(request, environment) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return environment.ASSETS.fetch(request);
    const expectedOrigin = apiOrigins.get(environment.CHALK_ENVIRONMENT);
    if (!expectedOrigin || environment.CHALK_API_ORIGIN !== expectedOrigin) return new Response("Account service unavailable", { status: 503 });
    const upstream = new URL(url.pathname + url.search, expectedOrigin);
    return fetch(new Request(upstream, request), { redirect: "manual" });
  },
};
