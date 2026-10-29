import { strict as assert } from "node:assert";
import { setTimeout as delay } from "node:timers/promises";

/** Exercise the already-loaded legacy tab's cache fallback, not a fabricated denial. */
export async function proveEvictionReload(context, origin) {
  const page = await context.newPage();
  let initial;
  let denials = 0;
  try {
    await page.route("**/dashboard-api/call", async (route) => {
      const request = route.request();
      const input = request.method() === "POST" ? request.postDataJSON() : null;
      if (input?.action === "join") {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        const dto = await response.json();
        initial = dto.access;
        // Only shorten client-facing metadata; the real grant and backend are unchanged.
        const expiry = new Date(Date.now() + 80000).toISOString();
        dto.access.media.expires_at = expiry;
        dto.access.sync.expires_at = expiry;
        await route.fulfill({ response, json: dto });
      } else if (input?.action === "refresh-access") {
        // Older loaded clients do not send the new per-tab handle.
        const forwarded = { ...input };
        delete forwarded.ownerSeat;
        const response = await route.fetch({ postData: JSON.stringify(forwarded) });
        assert.equal(response.status(), 401);
        assert.equal((await response.json()).error.code, "join_required");
        denials++;
        await route.fulfill({ response });
      } else await route.continue();
    });
    await page.goto(`${origin}/dashboard`);
    await page.getByRole("button", { name: "Start a call", exact: true }).click();
    await page.getByRole("button", { name: "Join call", exact: true }).click();
    await page.locator('[data-tour="video-grid"]').first().waitFor({ timeout: 45000 });
    assert(initial, "The original owner must join before evicting its entry");
    const { csrfToken } = await (await context.request.get(`${origin}/auth/session`)).json();
    for (let join = 0; join < 5; join++) {
      const response = await context.request.post(`${origin}/dashboard-api/call`, {
        headers: { Origin: origin, "X-CSRF-Token": csrfToken },
        data: { action: "join", spaceId: initial.subject.space_id, idempotencyKey: crypto.randomUUID() },
      });
      assert.equal(response.status(), 200);
    }
    await page.getByText("Access to this call was rejected. Refresh the page to rejoin.", { exact: true }).waitFor({ timeout: 45000 });
    assert.equal(await page.getByRole("button", { name: "Try again", exact: true }).count(), 0);
    await delay(5000);
    assert.equal(denials, 1, "An authoritative cache miss must stop automatic refresh retries");
    await page.screenshot({ path: "artifacts/dashboard-owner-eviction.png" });
    // Remove the legacy-client simulation: the reload must really navigate and rejoin.
    await page.unroute("**/dashboard-api/call");
    await Promise.all([page.waitForEvent("domcontentloaded"), page.getByRole("button", { name: "Reload page", exact: true }).click()]);
    await page.locator('[data-tour="video-grid"]').first().waitFor({ timeout: 45000 });
    console.log("PASS: five real sibling joins evict the legacy seat; real 401 shows reload guidance, stops retries, and Reload page rejoins");
  } finally {
    await page.close();
  }
}
