import { strict as assert } from "node:assert";

/** Part of the dashboard end-to-end journey. */
export async function signInChecks(h) {
  const { browser, post } = h;
  for (const provider of ["google", "apple"]) {
    for (const mismatch of provider === "google" ? ["state", "nonce", "challenge"] : ["state", "nonce"]) {
      const client = browser();
      const start = await client.request(`/auth/start?provider=${provider}`);
      const authorize = new URL(start.headers.get("location"));
      authorize.searchParams.set("person", "ada");
      authorize.searchParams.set(mismatch, "mismatch");
      const issued = await client.request(authorize);
      const callback = new URL(issued.headers.get("location"));
      const result = provider === "google" ? await client.request(callback) : await client.request(callback.pathname, { method: "POST", headers: { Origin: "https://appleid.apple.com", "Content-Type": "application/x-www-form-urlencoded" }, body: callback.searchParams.toString() });
      assert.equal(result.headers.get("location"), `/dashboard/sign-in?failed=${provider}`);
      assert.equal((await client.request("/auth/session")).status, 401);
    }
  }
  const appleSuccess = browser();
  const appleStart = await appleSuccess.request("/auth/start?provider=apple");
  const appleAuthorize = new URL(appleStart.headers.get("location"));
  appleAuthorize.searchParams.set("person", "ada");
  const appleIssued = await appleSuccess.request(appleAuthorize);
  const appleCallback = new URL(appleIssued.headers.get("location"));
  assert.equal((await appleSuccess.request(appleCallback.pathname)).status, 405);
  const appleFinished = await appleSuccess.request(appleCallback.pathname, { method: "POST", headers: { Origin: "https://appleid.apple.com", "Content-Type": "application/x-www-form-urlencoded" }, body: appleCallback.searchParams.toString() });
  assert.equal(appleFinished.headers.get("location"), "/dashboard");
  const appleSession = await (await appleSuccess.request("/auth/session")).json();
  assert.equal(appleSession.profile.name, "Ada Fixture");
  assert.equal((await post(appleSuccess, "/dashboard-api/home", { action: "create", name: "Untrusted" }, appleSession.csrfToken, { Origin: "https://appleid.apple.com" })).status, 403);
  assert.equal((await post(appleSuccess, "/auth/sign-out", {}, appleSession.csrfToken, { Origin: "https://appleid.apple.com" })).status, 403);
  const wrongApple = browser();
  const wrongStart = await wrongApple.request("/auth/start?provider=apple");
  const wrongAuthorize = new URL(wrongStart.headers.get("location"));
  wrongAuthorize.searchParams.set("person", "ada");
  const wrongIssued = new URL((await wrongApple.request(wrongAuthorize)).headers.get("location"));
  assert.equal((await wrongApple.request(wrongIssued.pathname, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" }, body: wrongIssued.searchParams.toString() })).headers.get("location"), "/dashboard/sign-in?failed=apple");
  assert.equal((await wrongApple.request("/auth/session")).status, 401);
  console.log("PASS: Google/Apple state and nonce, Google PKCE mismatches rejected; Apple form_post restricted to callback");
}
