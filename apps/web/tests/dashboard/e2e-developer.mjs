import { strict as assert } from "node:assert";
import { inviteCredential } from "./invite-credential.mjs";

/** Part of the dashboard end-to-end journey. */
export async function knockChecks(h, s) {
  const { apiOrigin, sql, post } = h;
  const { ada, firstTenant, session } = s;
  // Completed decisions are history, not new knocks the owner can answer again.
  const knockingCall = await post(ada, "/dashboard-api/home", { action: "create-call", admission: "knock", idempotencyKey: crypto.randomUUID() }, session.csrfToken);
  assert.equal(knockingCall.status, 200);
  const knockingSpace = (await knockingCall.json()).call.id;
  const invitation = await ada.request(`/dashboard-api/call?spaceId=${knockingSpace}`);
  const inviteToken = inviteCredential((await invitation.json()).inviteUrl);
  {
    const arrival = await fetch(`${process.env.DASHBOARD_TEST_API_ORIGIN}/v1/public/space-invite-arrivals`, {
      method: "POST",
      headers: { Authorization: "Bearer fixture-dashboard-service-token-not-a-secret", "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ space_invite_token: inviteToken, display_name: "Knocking guest" }),
    });
    assert.equal(arrival.status, 201, await arrival.clone().text());
    const waitingCall = await ada.request(`/dashboard-api/call?spaceId=${knockingSpace}`);
    const pending = (await waitingCall.json()).knocks;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].state, "pending");
    for (let index = 0; index < 50; index++) {
      const stale = await fetch(`${apiOrigin}/v1/public/space-invite-arrivals`, {
        method: "POST",
        headers: { Authorization: "Bearer fixture-dashboard-service-token-not-a-secret", "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ space_invite_token: inviteToken, display_name: `Expired guest ${index}` }),
      });
      assert.equal(stale.status, 201, await stale.clone().text());
    }
    sql(`update space_public_admission_requests set requested_at=now()-interval '10 minutes', expires_at=now()-interval '1 second' where space_id='${knockingSpace}' and request_handle<>'${pending[0].handle}'`);
    const actionable = await ada.request(`/dashboard-api/call?spaceId=${knockingSpace}`);
    assert.deepEqual(
      (await actionable.json()).knocks.map((knock) => knock.handle),
      [pending[0].handle],
      "Expired knocks cannot fill the engine list limit and hide a valid request",
    );
    sql(`update space_public_admission_requests set expires_at=now()-interval '1 second' where space_id='${knockingSpace}'`);
    const raw = await fetch(`${apiOrigin}/v1/tenants/${firstTenant}/spaces/${knockingSpace}/public-admission-requests?state=pending`, { headers: { Authorization: "Bearer fixture-dashboard-service-token-not-a-secret" } });
    assert.equal(raw.status, 200);
    assert.equal((await raw.json()).requests.length, 0, "Engine excludes expired pending knocks before its list limit");
    const expired = await ada.request(`/dashboard-api/call?spaceId=${knockingSpace}`);
    assert.deepEqual((await expired.json()).knocks, [], "Dashboard filters expired knocks at the server boundary");
    sql(`update space_public_admission_requests set expires_at=now()+interval '5 minutes' where request_handle='${pending[0].handle}'`);
    const decisionKey = crypto.randomUUID();
    const decided = await post(ada, "/dashboard-api/call", { action: "deny-knock", spaceId: knockingSpace, requestHandle: pending[0].handle, idempotencyKey: decisionKey }, session.csrfToken);
    assert.equal(decided.status, 200, await decided.clone().text());
    const accepted = await ada.request(`/dashboard-api/call-status?spaceId=${knockingSpace}`);
    const acceptedKnocks = (await accepted.json()).knocks;
    assert.equal(acceptedKnocks[0].decisionState, "in_flight", "Accepted denial stays busy until Sync commits");
    // This API-only harness has no Sync consumer. Seed its terminal result;
    // the real-Sync retry and two-browser proofs exercise that commit itself.
    sql(`update sync_admission_requests set status='denied', completed_at=now() where admission_request_id='${pending[0].handle}'`);
    const settled = await ada.request(`/dashboard-api/call-status?spaceId=${knockingSpace}`);
    assert.deepEqual((await settled.json()).knocks, [], "Sync denial removes the request from the shared status projection");
  }
  console.log("PASS: real engine excludes expired knocks before paging; dashboard keeps accepted decisions busy and hides Sync-denied knocks");
}

/** Part of the dashboard end-to-end journey. */
export async function keyChecks(h, s) {
  const { post } = h;
  const { ada, session } = s;

  const keyResponse = await post(ada, "/dashboard-api/developer", { action: "create-key", name: "Test", scopes: ["spaces:read"], expiresAt: "2027-01-01T00:00:00Z", idempotencyKey: crypto.randomUUID() }, session.csrfToken);
  assert.equal(keyResponse.status, 200, await keyResponse.clone().text());
  const createdKey = await keyResponse.json();
  const keyId = createdKey.id;
  const yearExpiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const yearKey = await post(ada, "/dashboard-api/developer", { action: "create-key", name: "One year", scopes: ["spaces:read"], expiresAt: yearExpiry, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
  assert.equal(yearKey.status, 200, await yearKey.clone().text());
  const tooLate = await post(ada, "/dashboard-api/developer", { action: "create-key", name: "Too late", scopes: ["spaces:read"], expiresAt: new Date(Date.now() + 366 * 24 * 60 * 60 * 1000).toISOString(), idempotencyKey: crypto.randomUUID() }, session.csrfToken);
  assert.equal(tooLate.status, 400, await tooLate.clone().text());
  assert.deepEqual(await tooLate.json(), { error: { code: "api_key_invalid_expiry" } });
  console.log("PASS: real dashboard and API accept one-year keys and preserve expiry validation errors");
  return { createdKey, keyId };
}

/** Part of the dashboard end-to-end journey. */
export async function webhookChecks(h, s) {
  const { unsupportedBodies, sql, post } = h;
  const { ada, session } = s;
  assert.equal((await post(ada, "/dashboard-api/developer", { action: "create-key", name: "Escalation", scopes: ["tenants:write"], expiresAt: "2027-01-01T00:00:00Z", idempotencyKey: crypto.randomUUID() }, session.csrfToken)).status, 400);
  const hookResponse = await post(ada, "/dashboard-api/developer", { action: "create-webhook", name: "Test", url: "https://example.com/hook?token=fixture-webhook-url-credential", enabled: true, eventTypes: ["episode.ended"], idempotencyKey: crypto.randomUUID() }, session.csrfToken);
  assert.equal(hookResponse.status, 200, await hookResponse.clone().text());
  const hook = (await hookResponse.json()).webhook;
  const webhookId = hook.id;
  const targetBefore = sql(`select current_target_revision from webhook_endpoints where id='${webhookId}'`);
  const urlBefore = sql(`select encode(url_ciphertext,'hex') from webhook_endpoint_revisions where endpoint_id='${webhookId}' and revision=${targetBefore}`);
  const updatedHook = await post(ada, "/dashboard-api/developer", { action: "update-webhook", webhookId, revision: hook.revision, enabled: false, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
  assert.equal(updatedHook.status, 200, await updatedHook.clone().text());
  const patch = unsupportedBodies.findLast((r) => r.method === "PATCH" && r.path.endsWith(`/webhook-endpoints/${webhookId}`));
  assert.deepEqual(JSON.parse(patch.body), { enabled: false });
  assert.equal(sql(`select enabled from webhook_endpoints where id='${webhookId}'`), "f");
  const targetAfter = sql(`select current_target_revision from webhook_endpoints where id='${webhookId}'`);
  assert.equal(sql(`select encode(url_ciphertext,'hex') from webhook_endpoint_revisions where endpoint_id='${webhookId}' and revision=${targetAfter}`), urlBefore);
  console.log("PASS: partial webhook update omits URL and preserves the actual encrypted destination");
  return { webhookId, updatedHook };
}
