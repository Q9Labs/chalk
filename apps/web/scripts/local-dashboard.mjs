import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Installed only by local-dev.mjs, not by an environment switch in deployed code. */
export function localDashboard() {
  const origin = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${process.env.CHALK_DEV_WEB_PORT || "3070"}`;
  const bindings = {
    CHALK_ENVIRONMENT: "local",
    CHALK_API_ORIGIN: process.env.CHALK_DEV_API_ORIGIN || "http://127.0.0.1:8080",
    DASHBOARD_ORIGIN: origin,
    GOOGLE_CLIENT_ID: "local-google",
    GOOGLE_CLIENT_SECRET: "local-google",
    APPLE_SERVICES_ID: "local-apple",
    APPLE_TEAM_ID: "local-apple",
    APPLE_KEY_ID: "local-apple",
    APPLE_PRIVATE_KEY: "local-apple",
    SESSION_SECRET: process.env.CHALK_DEV_DASHBOARD_SESSION_SECRET || randomBytes(32).toString("base64url"),
    DASHBOARD_SERVICE_TOKEN: process.env.CHALK_DEV_DASHBOARD_SERVICE_TOKEN || "web-only-no-dashboard-service",
    DASHBOARD_IDENTITY_PROVIDER: "fixture",
  };
  return {
    name: "local-dashboard",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (incoming, outgoing, next) => {
        const url = new URL(incoming.url, origin);
        // Both sign-in buttons use the Google-shaped local fixture, not a real IdP.
        if (url.pathname === "/auth/start" && url.searchParams.get("provider") === "apple") url.searchParams.set("provider", "google");
        const artifactPrefix = "/__local-dashboard-artifacts";
        const dashboard = url.pathname.startsWith("/auth/") || url.pathname.startsWith("/dashboard-api/") || url.pathname === "/fixture/authorize";
        if (!dashboard && !url.pathname.startsWith(`${artifactPrefix}/`)) return next();
        try {
          let response;
          if (!dashboard) {
            const artifacts = JSON.parse(await readFile(process.env.CHALK_DEV_DASHBOARD_ARTIFACTS, "utf8"));
            const artifact = artifacts[url.pathname.slice(artifactPrefix.length)];
            response = artifact === "preview-audio" ? new Response(previewAudio(), { headers: { "Content-Type": "audio/wav" } }) : artifact ? Response.json(artifact) : new Response("Not found", { status: 404 });
          } else {
            const chunks = [];
            for await (const chunk of incoming) chunks.push(chunk);
            const request = new Request(url, { method: incoming.method, headers: incoming.headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
            const { onRequest } = await server.ssrLoadModule("/tests/dashboard/fixture-entry.ts");
            response = await onRequest({ request, env: bindings });
          }
          outgoing.statusCode = response.status;
          for (const [name, value] of response.headers) if (name !== "set-cookie") outgoing.setHeader(name, value);
          const cookies = response.headers.getSetCookie();
          if (cookies.length) outgoing.setHeader("Set-Cookie", cookies);
          outgoing.setHeader("Cache-Control", "no-store");
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          server.config.logger.error(`Local dashboard: ${error instanceof Error ? error.message : "request failed"}`);
          outgoing.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ error: { code: "local_dashboard_unavailable" } }));
        }
      });
    },
  };
}

// A short, synthetic recording keeps playback reviewable without a media vendor.
function previewAudio() {
  const samples = 12000 * 8;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let sample = 0; sample < samples; sample++) wav.writeInt16LE(Math.round(Math.sin((sample * 2 * Math.PI * 220) / 8000) * 1000), 44 + sample * 2);
  return wav;
}
