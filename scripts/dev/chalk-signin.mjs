import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { FailureKind, failure } from "./model.mjs";

// Chalk has no password accounts. The user a reviewer can be is a guest who arrives through the seeded Space's public invite,
// so "the seeded user can sign in" means that arrival is admitted through the web origin, the same way the browser does it:
// the API answers with a guest cookie, and leaving presents that cookie.

export async function enableSeedInvite({ apiOrigin, systemToken, tenantId, spaceId } = {}) {
  const response = await fetch(new URL(`/v1/tenants/${tenantId}/spaces/${spaceId}/public-invite`, apiOrigin), {
    method: "PATCH",
    headers: { Authorization: `Bearer ${systemToken}`, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  if (!response.ok) throw failure(FailureKind.STARTUP, `seed invite PATCH failed with HTTP ${response.status}`, { stage: "bootstrap" });
  const invite = await response.json();
  const canonical = new URL(invite.canonical_url);
  const code = canonical.pathname.slice(1);
  if (!code) throw failure(FailureKind.STARTUP, "seed invite has no invite code in its canonical URL", { stage: "bootstrap" });
  return { code, path: `${canonical.pathname}${canonical.search}${canonical.hash}` };
}

/** Loads the invite page, arrives as the seeded guest through `origin`, checks the guest is admitted, then leaves. */
export async function proveSeededSignIn({ origin, invite, attempts = 3, retryDelayMs = 3000 } = {}) {
  const page = await fetch(new URL(invite.path, origin), { headers: { accept: "text/html" } });
  if (!page.ok || !(page.headers.get("content-type") || "").includes("text/html")) {
    throw failure(FailureKind.STARTUP, `seeded invite page did not load from ${origin} (HTTP ${page.status})`, { stage: "signin" });
  }
  // The arrival opens a real media connection, so a provider timeout can fail one attempt; a 4xx never retries.
  let arrival;
  for (let attempt = 1; ; attempt += 1) {
    arrival = await fetch(new URL("/v1/public/space-invite-arrivals", origin), {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": randomUUID(), origin },
      body: JSON.stringify({ display_name: "Seeded guest", space_invite_token: invite.code }),
    });
    if (arrival.status < 500 || attempt === attempts) break;
    await arrival.arrayBuffer();
    await delay(retryDelayMs);
  }
  if (arrival.status !== 201) throw failure(FailureKind.STARTUP, `seeded guest arrival through ${origin} failed with HTTP ${arrival.status}: ${(await arrival.text()).slice(0, 200)}`, { stage: "signin" });
  const body = await arrival.json();
  const leave = await fetch(new URL("/v1/public/space-invite-arrival", origin), {
    method: "DELETE",
    headers: {
      Cookie: arrival.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; "),
      "X-Chalk-Arrival-Handle": body.arrival_handle,
      origin,
    },
  });
  if (!leave.ok) throw failure(FailureKind.STARTUP, `seeded guest could not leave (HTTP ${leave.status}): ${(await leave.text()).slice(0, 200)}`, { stage: "signin" });
  return { state: body.state };
}
