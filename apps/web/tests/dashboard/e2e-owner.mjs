import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** Part of the dashboard end-to-end journey. */
export async function ownerChecks(h) {
  const { requests, tenantFor, sql, browser, signIn, post } = h;
  const ada = browser();
  let session = await signIn(ada, "ada");
  const firstTenant = (await tenantFor("ada")).id;
  assert.notEqual((await tenantFor("ada", "apple")).id, firstTenant, "Provider subjects must resolve to separate accounts");
  await signIn(ada, "ada");
  assert.equal((await tenantFor("ada")).id, firstTenant);
  assert.equal(sql("select count(*) from tenants where external_id = 'google:test:fixture_ada'"), "1");
  session = await (await ada.request("/auth/session")).json();
  const malik = browser();
  const other = await signIn(malik, "malik");
  const secondTenant = (await tenantFor("malik")).id;
  assert.notEqual(other.csrfToken, session.csrfToken);
  assert.equal((await ada.request("/auth/start?provider=google&returnTo=https%3A%2F%2Fevil.example")).status, 400);
  assert.equal((await ada.request("/auth/start?provider=google&returnTo=%2F%2Fevil.example")).status, 400);
  const count = requests.length;
  assert.equal((await post(ada, "/dashboard-api/home", {}, session.csrfToken, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await post(ada, "/dashboard-api/home", {}, "")).status, 403);
  // The icon route needs a session and refuses hosts that are not public DNS names, before any request leaves.
  assert.equal((await browser().request("/dashboard-api/favicon?host=example.com")).status, 401);
  for (const host of ["127.0.0.1", "localhost", "169.254.169.254", "printer.local", "example.com:8443"]) assert.equal((await ada.request(`/dashboard-api/favicon?host=${encodeURIComponent(host)}`)).status, 400, host);
  assert.equal((await post(ada, "/dashboard-api/home", {}, other.csrfToken)).status, 403);
  assert.equal(requests.length, count);
  const apple = browser();
  await apple.request("/auth/start?provider=apple");
  const failedApple = await apple.request("/auth/callback/apple", { method: "POST", headers: { Origin: "https://appleid.apple.com", "Content-Type": "application/x-www-form-urlencoded" }, body: "error=access_denied" });
  assert.equal(failedApple.status, 303);
  assert.equal(failedApple.headers.get("location"), "/dashboard/sign-in?failed=apple");
  assert(failedApple.headers.get("X-Request-ID"));
  const unnamed = await post(ada, "/dashboard-api/home", { action: "create-call", admission: "anyone", idempotencyKey: crypto.randomUUID() }, session.csrfToken);
  assert.equal(unnamed.status, 200, await unnamed.clone().text());
  assert.equal((await unnamed.json()).call.name, "New call");
  const unicode = await post(ada, "/dashboard-api/home", { action: "create-call", name: "اجتماع Réunion", admission: "anyone", idempotencyKey: crypto.randomUUID() }, session.csrfToken);
  assert.equal(unicode.status, 200, await unicode.clone().text());
  const unicodeId = (await unicode.json()).call.id;
  const rawInvite = await fetch(`${process.env.DASHBOARD_TEST_API_ORIGIN}/v1/tenants/${firstTenant}/spaces/${unicodeId}/public-invite`, { headers: { Authorization: "Bearer fixture-dashboard-service-token-not-a-secret" } });
  assert.equal(rawInvite.status, 200, await rawInvite.clone().text());
  const unicodeLink = (await rawInvite.json()).canonical_url;
  const unicodeHome = await ada.request("/dashboard-api/home");
  assert.equal(unicodeHome.status, 200, await unicodeHome.clone().text());
  assert.equal((await unicodeHome.json()).calls.find((call) => call.id === unicodeId).inviteUrl, null);
  const unicodeCall = await ada.request(`/dashboard-api/call?spaceId=${unicodeId}`);
  assert.equal(unicodeCall.status, 200, await unicodeCall.clone().text());
  assert.equal((await unicodeCall.json()).inviteUrl, unicodeLink);
  // Remove the regression fixture from later Home pagination assertions.
  assert.equal((await post(ada, "/dashboard-api/home", { action: "archive-call", spaceId: unicodeId }, session.csrfToken)).status, 200);
  const malikTenant = secondTenant;
  const created = await post(ada, "/dashboard-api/home", { action: "create-call", name: "Original", admission: "anyone", idempotencyKey: crypto.randomUUID() }, session.csrfToken);
  assert.equal(created.status, 200, await created.clone().text());
  const spaceId = (await created.json()).call.id;
  for (const action of [
    { action: "rename-call", spaceId, name: "Renamed" },
    { action: "set-admission", spaceId, admission: "knock" },
  ]) {
    const response = await post(ada, "/dashboard-api/home", action, session.csrfToken);
    assert.equal(response.status, 200, await response.clone().text());
  }
  const ownCall = await ada.request(`/dashboard-api/call?spaceId=${spaceId}`);
  assert.equal(ownCall.status, 200, await ownCall.clone().text());
  const storedSpace = JSON.parse(sql(`select row_to_json(s) from spaces s where id='${spaceId}'`));
  assert.equal(storedSpace.name, "Renamed");
  assert.equal(storedSpace.admission_policy.mode, "knock");
  assert.equal(storedSpace.default_episode_duration_seconds, 3600);
  let sourceEpisodeId;
  // Use separate Spaces so the historical attendance fixtures stay independent.
  for (const admission of ["anyone", "knock"]) {
    const createdCall = await post(ada, "/dashboard-api/home", { action: "create-call", name: `Owner ${admission}`, admission, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
    assert.equal(createdCall.status, 200, await createdCall.clone().text());
    const ownerSpaceId = (await createdCall.json()).call.id;
    const join = { action: "join", spaceId: ownerSpaceId, idempotencyKey: crypto.randomUUID() };
    const joined = await post(ada, "/dashboard-api/call", join, session.csrfToken);
    assert.equal(joined.status, 200, await joined.clone().text());
    const joinedDTO = await joined.json();
    const grant = joinedDTO.access;
    sourceEpisodeId = grant.subject.episode_id;
    assert(grant.sync.token && grant.media.token);
    // Exercise Sync's real UUID decoder, not a second copy of its regex.
    assert.equal(execFileSync("elixir", ["-r", resolve(import.meta.dirname, "../../../../apps/sync/lib/chalk_sync/uuid.ex"), "-e", "[id] = System.argv(); ChalkSync.UUID.dump!(id); IO.write(id)", "--", grant.subject.participant_id], { encoding: "utf8" }), grant.subject.participant_id);
    assert.equal(grant.subject.tenant_id, firstTenant);
    const replay = await post(ada, "/dashboard-api/call", join, session.csrfToken);
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.equal((await replay.json()).access.subject.participant_id, grant.subject.participant_id);
    assert.equal(sql(`select count(*) from participants where episode_id='${grant.subject.episode_id}'`), "1");
    sql(`update participants set status='active', joined_at=now(), first_joined_at=now() where id='${grant.subject.participant_id}';
  insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes)
  values('${firstTenant}','${ownerSpaceId}','${grant.subject.episode_id}','{"participants":[{"participant_id":"${grant.subject.participant_id}","display_name":"Owner"}]}',1,decode(repeat('00',32),'hex'),2)
  on conflict(tenant_id,space_id,episode_id) do update set folded_state=jsonb_set(sync_episode_control.folded_state,'{participants}',excluded.folded_state->'participants')`);
    const liveOffset = requests.length;
    const liveCall = await ada.request(`/dashboard-api/call?spaceId=${ownerSpaceId}`);
    assert.equal(liveCall.status, 200, await liveCall.clone().text());
    const liveDTO = await liveCall.json();
    assert(requests.length - liveOffset <= 41, "Call enrichment stays within its request bound");
    assert.equal(liveDTO.live.count, 1);
    assert.equal(liveDTO.live.participants[0].id, grant.subject.participant_id);
    assert.equal(liveDTO.episodes[0].participantCount, 1);
    const ownPast = await ada.request(`/dashboard-api/past-session?spaceId=${ownerSpaceId}&episodeId=${grant.subject.episode_id}`);
    assert.equal(ownPast.status, 200, await ownPast.clone().text());
    const ownerAttendance = (await ownPast.json()).attendance.participants[0];
    assert.equal(ownerAttendance.isYou, true);
    assert.equal(ownerAttendance.kind, "user");
    assert.equal(ownerAttendance.externalId, null);
    sql(
      `update participants set status='joining', joined_at=null, first_joined_at=null where id='${grant.subject.participant_id}'; update sync_episode_control set folded_state=jsonb_set(folded_state,'{participants}','[]'::jsonb) where tenant_id='${firstTenant}' and episode_id='${grant.subject.episode_id}'`,
    );
    const refreshedAccess = await post(ada, "/dashboard-api/call", { action: "refresh-access", spaceId: ownerSpaceId }, session.csrfToken);
    // Already-loaded bundles without a join key retain their signed single-seat path.
    // An admitted joining seat can refresh before Sync confirms entry.
    assert.equal(refreshedAccess.status, 200, await refreshedAccess.clone().text());
    const refreshedDTO = await refreshedAccess.json();
    const refreshedGrant = refreshedDTO.access;
    assert.equal(refreshedGrant.subject.participant_id, grant.subject.participant_id);
    // Tabs in one signed-in browser share cookies, but own different seats.
    // Production returned 403 media_token.subject_mismatch here, surfaced as 502.
    const otherJoin = { ...join, idempotencyKey: crypto.randomUUID() };
    const otherJoined = await post(ada, "/dashboard-api/call", otherJoin, session.csrfToken);
    assert.equal(otherJoined.status, 200, await otherJoined.clone().text());
    const otherDTO = await otherJoined.json();
    const otherGrant = otherDTO.access;
    assert.notEqual(otherGrant.subject.participant_id, grant.subject.participant_id);
    for (const [initial, joinKey, initialSeat] of [
      [refreshedGrant, join.idempotencyKey, refreshedDTO.ownerSeat],
      [otherGrant, otherJoin.idempotencyKey, otherDTO.ownerSeat],
    ]) {
      let access = initial;
      let ownerSeat = initialSeat;
      for (const replaceMedia of [false, true]) {
        const refreshed = await post(ada, "/dashboard-api/call", { action: "refresh-access", spaceId: ownerSpaceId, joinKey, ownerSeat, ...(!replaceMedia ? { currentMediaToken: access.media.token } : {}) }, session.csrfToken);
        assert.equal(refreshed.status, 200, `A sibling tab must not replace this tab's owner seat: ${await refreshed.clone().text()}`);
        const dto = await refreshed.json();
        access = dto.access;
        ownerSeat = dto.ownerSeat;
        assert.equal(access.subject.participant_id, initial.subject.participant_id);
      }
    }
    const unknownSeat = await post(ada, "/dashboard-api/call", { action: "refresh-access", spaceId: ownerSpaceId, joinKey: crypto.randomUUID() }, session.csrfToken);
    assert.equal(unknownSeat.status, 401, "A join key without its sealed seat cookie grants no authority");
    if (admission === "knock") {
      const guest = await fetch(`${process.env.DASHBOARD_TEST_API_ORIGIN}/v1/tenants/${firstTenant}/spaces/${ownerSpaceId}/episodes/${grant.subject.episode_id}/participants`, {
        method: "POST",
        headers: { Authorization: "Bearer fixture-dashboard-service-token-not-a-secret", "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ name: "Guest", role: "observer", participant_id: crypto.randomUUID() }),
      });
      assert.equal(guest.status, 201, await guest.clone().text());
      const waiting = await guest.json();
      assert(waiting.admission_request);
      assert(!waiting.access);
    }
    // A deliberate rejoin after a leave gets a fresh seat, not the replay seat.
    // Sync is not running in this harness; seed its completed leave state.
    sql(`update participants set status='left', left_at=now() where id='${grant.subject.participant_id}'`);
    const rejoin = await post(ada, "/dashboard-api/call", { ...join, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
    assert.equal(rejoin.status, 200, await rejoin.clone().text());
    assert.notEqual((await rejoin.json()).access.subject.participant_id, grant.subject.participant_id);
    const end = await post(ada, "/dashboard-api/call", { action: "end-for-everyone", spaceId: ownerSpaceId, episodeId: grant.subject.episode_id, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
    assert.equal(end.status, 200, await end.clone().text());
    assert.equal(sql(`select status from episodes where id='${grant.subject.episode_id}'`), "ending");
  }
  console.log("PASS: owner open/knock grants, shared-cookie tab refresh/replacement isolation, same-key replay, new-key rejoin, end-for-everyone accepted, guest knock still waits");
  return { ada, session, firstTenant, malik, other, secondTenant, malikTenant, spaceId, sourceEpisodeId };
}
