import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ASSET_RECORDS, ATLAS_BUILD_ID } from "../.generated/atlas";
import worker, { type Environment } from "./index";

const accessCode = "correct-horse-atlas-battery";
const accessCodeHash = createHash("sha256").update(accessCode).digest("hex");

function environment(rateLimitSuccess = true): Environment {
  return {
    ATLAS_ACCESS_CODE_SHA256: accessCodeHash,
    ATLAS_SESSION_SECRET: "test-session-secret-with-at-least-32-bytes",
    LOGIN_RATE_LIMITER: {
      limit: async () => ({ success: rateLimitSuccess }),
    },
  };
}

async function request(path = "/", init?: RequestInit, env = environment()): Promise<Response> {
  return worker.fetch(new Request(`https://atlas.example.test${path}`, init), env);
}

async function login(code = accessCode, env = environment()): Promise<Response> {
  return request(
    "/_auth/login",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://atlas.example.test",
        "CF-Connecting-IP": "203.0.113.4",
        "User-Agent": "atlas-worker-test",
      },
      body: new URLSearchParams({ accessCode: code, returnTo: "/" }),
    },
    env,
  );
}

function sessionCookie(response: Response): string {
  return (response.headers.get("set-cookie") || "").split(";", 1)[0];
}

describe("protected architecture Worker", () => {
  it("renders the access-code screen for anonymous HTML and asset requests", async () => {
    const html = await request();
    expect(html.status).toBe(401);
    expect(html.headers.get("cache-control")).toBe("no-store");
    expect(html.headers.get("x-frame-options")).toBe("DENY");
    expect(await html.text()).toContain('action="/_auth/login"');

    const [assetPath] = Object.keys(ASSET_RECORDS);
    const asset = await request(assetPath);
    expect(asset.status).toBe(401);
    expect(asset.headers.get("content-type")).toContain("text/html");
    expect(await asset.text()).toContain("Architecture atlas");
  });

  it("rejects an invalid code without issuing a session", async () => {
    const response = await login("definitely-not-the-access-code");
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toContain("not accepted");
  });

  it("rejects cross-origin browser login submissions", async () => {
    const response = await request("/_auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "cross-site",
      },
      body: new URLSearchParams({ accessCode, returnTo: "/" }),
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rate limits login before checking the access code", async () => {
    const response = await login(accessCode, environment(false));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("cannot bypass the client-IP limit by rotating User-Agent", async () => {
    let attempts = 0;
    const env = environment();
    env.LOGIN_RATE_LIMITER.limit = async () => ({ success: ++attempts <= 10 });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request(
        "/_auth/login",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: "https://atlas.example.test",
            "CF-Connecting-IP": "203.0.113.4",
            "User-Agent": `rotating-agent-${attempt}`,
          },
          body: new URLSearchParams({ accessCode: "wrong", returnTo: "/" }),
        },
        env,
      );
      expect(response.status).toBe(401);
    }
    const limited = await login("wrong", env);
    expect(limited.status).toBe(429);
  });

  it("rejects an oversized login body without relying on Content-Length", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`accessCode=${"a".repeat(5000)}`));
        controller.close();
      },
    });
    const response = await request("/_auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://atlas.example.test",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("oversized");
  });

  it("issues a signed secure session and rejects tampering", async () => {
    const response = await login();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    const setCookie = response.headers.get("set-cookie") || "";
    expect(setCookie).toContain("__Host-chalk_atlas_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");

    const cookie = sessionCookie(response);
    expect((await request("/", { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await request("/", { headers: { Cookie: `${cookie}tampered` } })).status).toBe(401);
  });

  it("rejects backslash-based external return paths", async () => {
    const response = await request("/_auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://atlas.example.test",
      },
      body: new URLSearchParams({ accessCode, returnTo: "/\\attacker.example" }),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
  });

  it("serves the self-contained atlas and integrity-checked assets only after authentication", async () => {
    const cookie = sessionCookie(await login());
    const htmlResponse = await request("/", { headers: { Cookie: cookie } });
    const html = await htmlResponse.text();
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get("x-chalk-atlas-build")).toBe(ATLAS_BUILD_ID);
    expect(htmlResponse.headers.get("content-security-policy")).toContain("script-src 'sha256-");
    expect(html).not.toMatch(/\b(?:src|href)=["']\.\.?\//i);

    for (const [assetPath, expected] of Object.entries(ASSET_RECORDS)) {
      expect(html).toContain(assetPath);
      const asset = await request(assetPath, { headers: { Cookie: cookie } });
      const bytes = Buffer.from(await asset.arrayBuffer());
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toBe(expected.contentType);
      expect(asset.headers.get("x-content-sha256")).toBe(expected.sha256);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected.sha256);
    }
  });

  it("keeps the manifest protected and clears the session on logout", async () => {
    const cookie = sessionCookie(await login());
    expect((await request("/__atlas/manifest")).status).toBe(401);
    const manifest = await request("/__atlas/manifest", { headers: { Cookie: cookie } });
    expect(manifest.status).toBe(200);
    expect((await manifest.json()) as { buildId: string }).toMatchObject({ buildId: ATLAS_BUILD_ID });

    const logout = await request("/_auth/logout", { method: "POST", headers: { Cookie: cookie } });
    expect(logout.status).toBe(303);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
