import { strict as assert } from "node:assert";

function seats(cookies) {
  return cookies.filter((cookie) => /^local_chalk_seats?$|^local_chalk_seat_/.test(cookie.name));
}
export async function proveCookieBudget(context, origin) {
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/dashboard`);
    await page.evaluate(async () => {
      const session = await (await fetch("/auth/session")).json();
      const post = async (path, body) => {
        const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`Cookie-budget request failed: HTTP ${response.status} ${await response.text()}`);
        return response.json();
      };
      for (let space = 0; space < 12; space++) {
        const { call } = await post("/dashboard-api/home", { action: "create-call", name: "Cookie budget fixture", admission: "anyone", idempotencyKey: crypto.randomUUID() });
        for (let join = 0; join < 25; join++) await post("/dashboard-api/call", { action: "join", spaceId: call.id, idempotencyKey: crypto.randomUUID() });
      }
    });
    const cookies = await context.cookies();
    assert(
      cookies.some((cookie) => cookie.name === "local_chalk_session"),
      "300 joins must not evict the session cookie",
    );
    assert(
      cookies.some((cookie) => cookie.name === "local_chalk_binding"),
      "300 joins must not evict the binding cookie",
    );
    assert.equal(seats(cookies).length, 1, "Seat-cookie count must be independent of joins and Spaces");
    assert(cookies.length <= 4, `Expected only session, binding, Tenant and seat cache, got ${cookies.length}`);
    for (const cookie of seats(cookies)) {
      assert(cookie.value.length < 4096, "The bounded seat cache must fit in one cookie");
      assert(cookie.expires <= Date.now() / 1000 + 301, "Seats must expire with real credentials, not after 24 hours");
    }
    assert.equal((await context.request.get(`${origin}/auth/session`)).status(), 200);
    console.log(`PASS: 300 real dashboard joins across 12 Spaces leave ${cookies.length} Chromium cookies; session and binding survive`);
  } finally {
    await page.close();
  }
}
export async function assertNoSeatCookies(context) {
  assert.deepEqual(seats(await context.cookies()), [], "Leaving/ending/signing out must clear all seat cookies");
}
export async function proveSignOutCleanup(context, origin) {
  // Exercise migration cleanup for both earlier deployed and reviewed cookie names.
  await context.addCookies(["seats", `seat_${crypto.randomUUID()}`, `seat_${crypto.randomUUID()}_${crypto.randomUUID()}`].map((purpose) => ({ name: `local_chalk_${purpose}`, value: "stale-seat-fixture", url: origin, httpOnly: true, sameSite: "Lax" })));
  const session = await (await context.request.get(`${origin}/auth/session`)).json();
  const response = await context.request.post(`${origin}/auth/sign-out`, { headers: { Origin: origin, "X-CSRF-Token": session.csrfToken }, data: {} });
  assert.equal(response.status(), 200);
  await assertNoSeatCookies(context);
  assert(!(await context.cookies()).some((cookie) => ["local_chalk_session", "local_chalk_binding"].includes(cookie.name)));
  console.log("PASS: sign-out clears current and legacy seat cookies as well as session and binding");
}
