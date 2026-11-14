import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Part of the dashboard end-to-end journey. */
export async function historyChecks(h, s) {
  const { engineRequests, throttle, sql, post } = h;
  const { ada, createdKey, firstTenant, keyId, session, sourceEpisodeId, spaceId, updatedHook, webhookId } = s;
  const ownDeliveries = await post(ada, "/dashboard-api/developer", { action: "webhook-deliveries", webhookId }, session.csrfToken);
  assert.equal(ownDeliveries.status, 200, await ownDeliveries.clone().text());
  assert.deepEqual((await ownDeliveries.json()).deliveries, []);
  const enabledHook = await post(ada, "/dashboard-api/developer", { action: "update-webhook", webhookId, revision: (await updatedHook.json()).webhook.revision, enabled: true, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
  assert.equal(enabledHook.status, 200, await enabledHook.clone().text());
  const testDelivery = await post(ada, "/dashboard-api/developer", { action: "test-webhook", webhookId, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
  assert.equal(testDelivery.status, 200, await testDelivery.clone().text());
  const testDeliveryId = (await testDelivery.json()).deliveryId;
  // The API's dispatcher may already hold this delivery's lease and its started attempt row.
  // Taking the lease away makes the dispatcher's lease-guarded completion a no-op.
  sql(`update webhook_deliveries set attempt_count=1, state='succeeded', next_attempt_at=null, terminal_at=now(), lease_token=null, lease_owner=null, lease_expires_at=null where id='${testDeliveryId}';
insert into webhook_delivery_attempts(id,tenant_id,delivery_id,attempt_number,started_at,finished_at,latency_milliseconds,outcome,http_status) values(gen_random_uuid(),'${firstTenant}','${testDeliveryId}',1,now(),now(),1,'succeeded',204)
on conflict (tenant_id,delivery_id,attempt_number) do update set finished_at=excluded.finished_at, latency_milliseconds=excluded.latency_milliseconds, outcome=excluded.outcome, http_status=excluded.http_status;
update api_keys set last_used_at='2026-10-18T00:00:00Z' where id='${keyId}'`);
  const developer = await ada.request("/dashboard-api/developer");
  assert.equal(developer.status, 200, await developer.clone().text());
  const developerDTO = await developer.json();
  assert.equal(developerDTO.tenantId, firstTenant);
  assert.equal(developerDTO.keys.find((key) => key.id === keyId).lastUsedAt, "2026-10-18T00:00:00Z");
  assert.ok(createdKey.secret.startsWith(developerDTO.keys.find((key) => key.id === keyId).prefix), "a new secret starts with its row's prefix");
  const lastDelivery = developerDTO.webhooks.find((hook) => hook.id === webhookId).lastDelivery;
  assert.equal(lastDelivery.id, testDeliveryId);
  assert(lastDelivery.eventType);
  assert.equal(lastDelivery.status, 204);
  assert.equal(lastDelivery.attempts, 1);
  const deliveryRows = await post(ada, "/dashboard-api/developer", { action: "webhook-deliveries", webhookId }, session.csrfToken);
  assert.equal(deliveryRows.status, 200, await deliveryRows.clone().text());
  assert.deepEqual(
    (await deliveryRows.json()).deliveries.find((d) => d.id === testDeliveryId),
    lastDelivery,
  );
  const foreign = { spaceId, episodeId: crypto.randomUUID(), recordingId: crypto.randomUUID(), transcriptId: crypto.randomUUID(), keyId, webhookId, deliveryId: crypto.randomUUID() };
  // Provider artifacts are seeded, not mocked. Every read/authorization uses the
  // production HTTP server and PostgreSQL repositories; no vendor is contacted.
  sql(`insert into episodes(id,tenant_id,space_id,status,started_at,ended_at,config_snapshot) values('${foreign.episodeId}','${firstTenant}','${spaceId}','ended',now()-interval '1 hour',now(),(select config_snapshot from episodes where id='${sourceEpisodeId}'));
insert into recordings(id,tenant_id,space_id,episode_id,status,storage_provider) values('${foreign.recordingId}','${firstTenant}','${spaceId}','${foreign.episodeId}','failed','r2');
insert into transcriptions(id,tenant_id,space_id,episode_id,recording_id,status,languages) values('${foreign.transcriptId}','${firstTenant}','${spaceId}','${foreign.episodeId}','${foreign.recordingId}','terminal_failure','{en}');
insert into participants(id,tenant_id,space_id,episode_id,name,capabilities,generation,status,role,joined_at,first_joined_at) select gen_random_uuid(),'${firstTenant}','${spaceId}','${foreign.episodeId}','Same name',array['subscribe'],1,'active','owner',now()-interval '1 hour',now()-interval '1 hour' from generate_series(1,2);`);
  const past = await ada.request(`/dashboard-api/past-session?spaceId=${spaceId}&episodeId=${foreign.episodeId}`);
  assert.equal(past.status, 200, await past.clone().text());
  const pastDTO = await past.json();
  assert.equal(pastDTO.attendance.participants.length, 2);
  assert(pastDTO.attendance.participants.every((p) => p.name === "Same name" && p.kind === "user" && p.externalId === null && p.isYou === false && p.firstJoinedAt && Date.parse(p.lastLeftAt) === Date.parse(pastDTO.episode.endedAt)));
  assert.equal(pastDTO.recordings[0].id, foreign.recordingId);
  const ownTranscripts = await post(ada, "/dashboard-api/past-session", { action: "transcripts", spaceId, episodeId: foreign.episodeId, recordingId: foreign.recordingId }, session.csrfToken);
  assert.equal(ownTranscripts.status, 200, await ownTranscripts.clone().text());
  assert.equal((await ownTranscripts.json()).transcripts[0].id, foreign.transcriptId);
  const enrichedCall = await ada.request(`/dashboard-api/call?spaceId=${spaceId}`);
  assert.equal(enrichedCall.status, 200, await enrichedCall.clone().text());
  const historical = (await enrichedCall.json()).episodes.find((episode) => episode.id === foreign.episodeId);
  assert.equal(historical.participantCount, 2);
  assert.equal(historical.recordings[0].status, "failed");
  assert.equal(historical.recordings[0].transcripts[0].status, "terminal_failure");
  // Copy/share uses the session's tenant and only reads the invite, even when history fails.
  throttle.path = `/v1/tenants/${firstTenant}/spaces/${spaceId}/episodes`;
  try {
    assert.equal((await ada.request(`/dashboard-api/call?spaceId=${spaceId}`)).status, 429);
    const offset = engineRequests.length;
    const invite = await ada.request(`/dashboard-api/call-invite?spaceId=${spaceId}`);
    assert.equal(invite.status, 200, await invite.clone().text());
    assert.deepEqual(Object.keys(await invite.json()), ["inviteUrl"]);
    assert.deepEqual(
      engineRequests.slice(offset).map(({ method, path }) => [method, path.split("?")[0]]),
      [["GET", `/v1/tenants/${firstTenant}/spaces/${spaceId}/public-invite`]],
    );
    assert.equal((await ada.request("/dashboard-api/call-invite?spaceId=invalid")).status, 400);
    assert.equal((await ada.request(`/dashboard-api/call-invite?spaceId=${spaceId}&cursor=unexpected`)).status, 400);
    console.log("PASS: invite-only read uses one engine GET with the cached session tenant despite failing history; rejects invalid IDs and extra fields");
  } finally {
    throttle.path = undefined;
  }
  return { foreign };
}

/** Part of the dashboard end-to-end journey. */
export async function transcriptChecks(h, s) {
  const { requests, engineReads, unsupportedBodies, tenantFor, sql, post } = h;
  const { ada, firstTenant, foreign, malik, malikTenant, other, secondTenant, session, spaceId } = s;
  for (const [kind, id] of [
    ["recording", foreign.recordingId],
    ["transcript", foreign.transcriptId],
  ]) {
    const offset = engineReads.length;
    const metadata = await ada.request(`/dashboard-api/call-metadata?kind=${kind}&spaceId=${spaceId}&id=${id}`);
    assert.equal(metadata.status, 200, await metadata.clone().text());
    const result = await metadata.json();
    assert.equal(result.kind, kind);
    assert.equal(result[kind].id, id);
    if (kind === "recording") {
      assert.equal(result.recording.sourceStatus, "failed");
      assert.equal(result.recording.exportStatus, "unavailable");
      assert.equal(result.recording.transcriptionStatus, "failed");
      assert.equal(result.recording.failureMessage, "The recording capture did not complete.");
      assert.equal(result.recording.transcripts[0].id, foreign.transcriptId);
    }
    assert.equal(engineReads.slice(offset).filter((read) => read.path.startsWith(`/v1/tenants/${firstTenant}/`)).length, kind === "recording" ? 2 : 1, "Recording discovery costs two tenant reads; transcript refresh costs one");
  }
  const retry = await post(ada, "/dashboard-api/past-session", { action: "create-transcript", spaceId, episodeId: foreign.episodeId, recordingId: foreign.recordingId, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
  assert.equal(retry.status, 409, await retry.clone().text());
  assert(unsupportedBodies.some((r) => r.method === "POST" && r.path.endsWith(`/recordings/${foreign.recordingId}/transcripts`)));
  const documentFixture = JSON.stringify({
    schemaVersion: "transcript.v1",
    jobId: crypto.randomUUID(),
    episodeId: foreign.episodeId,
    provider: "cloudflare",
    model: "fixture",
    versionContract: "v1",
    attempt: 0,
    measuredAudioMs: 1000,
    cues: [
      {
        startMs: 0,
        endMs: 1000,
        identity: { kind: "participant", participantRef: "speaker-1", participantGeneration: 1, trackId: "audio", trackEpoch: "one" },
        trackClass: "microphone",
        displayNameSnapshot: "Speaker name",
        text: "Hello",
        overlap: false,
        provider: "cloudflare",
        model: "fixture",
        versionContract: "v1",
        attempt: 0,
      },
    ],
  });
  await writeFile(resolve(import.meta.dirname, "../../../../artifacts/dashboard-transcript.json"), documentFixture);
  sql(`update transcriptions set status='complete', artifact_key='transcript.json', artifact_size=${Buffer.byteLength(documentFixture)}, artifact_content_type='application/json' where id='${foreign.transcriptId}'`);
  const documentResponse = await post(ada, "/dashboard-api/past-session", { action: "transcript-document", spaceId, episodeId: foreign.episodeId, transcriptId: foreign.transcriptId }, session.csrfToken);
  assert.equal(documentResponse.status, 200, await documentResponse.clone().text());
  assert.deepEqual((await documentResponse.json()).cues, [{ startMs: 0, endMs: 1000, text: "Hello", speaker: { name: "Speaker name", participantRef: "speaker-1" } }]);
  sql(`update recordings set duration_millis=2520000, created_at='2026-11-01T00:00:00Z' where id='${foreign.recordingId}'`);
  const textDownload = await ada.request(`/dashboard-api/transcript-text?spaceId=${spaceId}&episodeId=${foreign.episodeId}&transcriptId=${foreign.transcriptId}`);
  assert.equal(textDownload.status, 200, await textDownload.clone().text());
  assert.equal(textDownload.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(textDownload.headers.get("content-disposition"), /attachment; filename="[^"]+-2026-11-01\.txt"/);
  assert.equal(await textDownload.text(), `${sql(`select name from spaces where id='${spaceId}'`)} · 1 Nov 2026 · 42 min\nLanguages: English\n\n[00:00:00] Speaker name: Hello\n`);
  const freshRecordingId = crypto.randomUUID();
  sql(`insert into recordings(id,tenant_id,space_id,episode_id,status,storage_provider) values('${freshRecordingId}','${firstTenant}','${spaceId}','${foreign.episodeId}','failed','r2');
insert into recording_transcription_sources(recording_id,tenant_id,manifest_key,manifest_sha256,manifest_size,manifest_content_type,schema_version,committed_at,generation,commit_digest,presentation_sha256,status,expires_at)
values('${freshRecordingId}','${firstTenant}','transcription/source/${freshRecordingId}/manifest.json',decode(repeat('00',32),'hex'),1,'application/json',1,now(),1,decode(repeat('00',32),'hex'),decode(repeat('00',32),'hex'),'ready',now()+interval '1 hour');
insert into recording_transcription_source_chunks(id,recording_id,tenant_id,chunk_index,generation,start_ms,end_ms,source_start_ms,source_end_ms,participant_ref,participant_generation,track_id,track_epoch,identity_kind,track_class,display_name_snapshot,overlap,storage_key,checksum,size,content_type)
values(gen_random_uuid(),'${freshRecordingId}','${firstTenant}',0,1,0,1000,0,1000,'participant-1',1,'track-1','1','participant','microphone','Speaker',false,'transcription/source/${freshRecordingId}/chunk-0.flac',decode(repeat('00',32),'hex'),1,'audio/flac')`);
  const transcriptRequest = { action: "create-transcript", spaceId, episodeId: foreign.episodeId, recordingId: freshRecordingId, idempotencyKey: crypto.randomUUID() };
  const requestsBeforeInvalid = unsupportedBodies.filter((request) => request.method === "POST" && request.path.endsWith(`/recordings/${freshRecordingId}/transcripts`)).length;
  assert.equal((await post(ada, "/dashboard-api/past-session", { ...transcriptRequest, idempotencyKey: "" }, session.csrfToken)).status, 400);
  assert.equal(unsupportedBodies.filter((request) => request.method === "POST" && request.path.endsWith(`/recordings/${freshRecordingId}/transcripts`)).length, requestsBeforeInvalid);
  const requestedTranscript = await post(ada, "/dashboard-api/past-session", transcriptRequest, session.csrfToken);
  assert.equal(requestedTranscript.status, 200, await requestedTranscript.clone().text());
  const submitted = unsupportedBodies.findLast((request) => request.method === "POST" && request.path.endsWith(`/recordings/${freshRecordingId}/transcripts`));
  assert.equal("languages" in JSON.parse(submitted.body), false);
  const transcriptId = (await requestedTranscript.json()).transcript.id;
  const replayedTranscript = await post(ada, "/dashboard-api/past-session", transcriptRequest, session.csrfToken);
  assert.equal(replayedTranscript.status, 200, await replayedTranscript.clone().text());
  assert.equal((await replayedTranscript.json()).transcript.id, transcriptId);
  for (const path of [
    `/dashboard-api/call?spaceId=${spaceId}`,
    `/dashboard-api/call-metadata?kind=recording&spaceId=${spaceId}&id=${foreign.recordingId}`,
    `/dashboard-api/call-metadata?kind=transcript&spaceId=${spaceId}&id=${foreign.transcriptId}`,
    `/dashboard-api/home-status?spaceIds=${spaceId}`,
    `/dashboard-api/past-session?spaceId=${spaceId}&episodeId=${foreign.episodeId}`,
    `/dashboard-api/transcript-text?spaceId=${spaceId}&episodeId=${foreign.episodeId}&transcriptId=${foreign.transcriptId}`,
  ])
    assert.equal((await malik.request(path)).status, 404);
  const foreignStatus = await malik.request(`/dashboard-api/call-status?spaceId=${spaceId}`);
  assert.equal(foreignStatus.status, 200);
  assert.deepEqual(await foreignStatus.json(), { latestEpisodeId: null, episode: null, knocks: [] });
  const mutations = [
    ["call", { action: "rename-call", spaceId: foreign.spaceId, name: "Renamed" }],
    ["call", { action: "set-admission", spaceId: foreign.spaceId, admission: "knock" }],
    ["home", { action: "rename-call", spaceId: foreign.spaceId, name: "Renamed" }],
    ["home", { action: "set-admission", spaceId: foreign.spaceId, admission: "knock" }],
    ["home", { action: "archive-call", spaceId: foreign.spaceId }],
    ["home", { action: "restore-call", spaceId: foreign.spaceId }],
    ["call", { action: "join", spaceId: foreign.spaceId, idempotencyKey: crypto.randomUUID() }],
    ["call", { action: "rotate-link", spaceId: foreign.spaceId, idempotencyKey: crypto.randomUUID() }],
    ["call", { action: "end-for-everyone", spaceId: foreign.spaceId, episodeId: foreign.episodeId, idempotencyKey: crypto.randomUUID() }],
    ["call", { action: "approve-knock", spaceId: foreign.spaceId, requestHandle: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }],
    ["call", { action: "deny-knock", spaceId: foreign.spaceId, requestHandle: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }],
    ...["recording-url", "export-recording", "transcripts", "create-transcript"].map((action) => [
      "past-session",
      {
        action,
        spaceId: foreign.spaceId,
        episodeId: foreign.episodeId,
        recordingId: foreign.recordingId,
        ...(action === "recording-url" ? { download: true } : action === "export-recording" || action === "create-transcript" ? { idempotencyKey: crypto.randomUUID() } : {}),
      },
    ]),
    ...["transcript-document", "delete-transcript"].map((action) => ["past-session", { action, spaceId: foreign.spaceId, episodeId: foreign.episodeId, transcriptId: foreign.transcriptId }]),
    ["developer", { action: "rotate-key", keyId: foreign.keyId, expiresAt: "2027-01-01T00:00:00Z", idempotencyKey: crypto.randomUUID() }],
    ["developer", { action: "revoke-key", keyId: foreign.keyId }],
    ["developer", { action: "update-webhook", webhookId: foreign.webhookId, name: "Test", url: "https://example.test/hook", enabled: true, eventTypes: ["episode.ended"], revision: 1, idempotencyKey: crypto.randomUUID() }],
    ["developer", { action: "delete-webhook", webhookId: foreign.webhookId, revision: 1, idempotencyKey: crypto.randomUUID() }],
    ["developer", { action: "rotate-webhook-secret", webhookId: foreign.webhookId, revokePreviousImmediately: true, idempotencyKey: crypto.randomUUID() }],
    ["developer", { action: "test-webhook", webhookId: foreign.webhookId, idempotencyKey: crypto.randomUUID() }],
    ["developer", { action: "webhook-deliveries", webhookId: foreign.webhookId }],
    ["developer", { action: "webhook-delivery", webhookId: foreign.webhookId, deliveryId: foreign.deliveryId }],
    ["developer", { action: "redeliver-webhook", webhookId: foreign.webhookId, deliveryId: foreign.deliveryId, idempotencyKey: crypto.randomUUID() }],
  ];
  for (const [page, action] of mutations) {
    const offset = requests.length;
    const response = await post(malik, `/dashboard-api/${page}`, action, other.csrfToken);
    assert.equal(response.status, 404, `${action.action}: ${await response.clone().text()}`);
    const attempted = requests.slice(offset).filter((path) => path.startsWith("/v1/tenants/") && !path.startsWith("/v1/tenants/by-external-id"));
    assert(attempted.length > 0, `${action.action} did not exercise an engine path`);
    assert(
      attempted.every((path) => path.startsWith(`/v1/tenants/${malikTenant}/`)),
      `${action.action} escaped the authenticated Tenant`,
    );
    assert(!attempted.some((path) => path.includes(firstTenant)));
  }
  assert.equal((await post(malik, "/dashboard-api/call", { action: "refresh-access", spaceId: foreign.spaceId, joinKey: crypto.randomUUID() }, other.csrfToken)).status, 401);
  assert.equal((await post(malik, "/dashboard-api/call", { action: "refresh-access", spaceId: foreign.spaceId, joinKey: crypto.randomUUID(), participantId: foreign.recordingId }, other.csrfToken)).status, 400);
  assert.equal((await post(malik, "/dashboard-api/home", { action: "archive-call", spaceId: foreign.spaceId, tenantId: firstTenant }, other.csrfToken)).status, 400);

  assert.equal((await tenantFor("malik")).recording_render_mode, "on_demand");
  const automatic = await post(malik, "/dashboard-api/developer", { action: "set-recording-render-mode", mode: "automatic" }, other.csrfToken);
  assert.equal(automatic.status, 200, await automatic.clone().text());
  assert.deepEqual(await automatic.json(), { recordingRenderMode: "automatic" });
  assert.deepEqual(unsupportedBodies.at(-1), { method: "PATCH", path: `/v1/tenants/${secondTenant}`, body: JSON.stringify({ recording_render_mode: "automatic" }) });
  assert.equal((await tenantFor("malik")).recording_render_mode, "automatic");
  assert.equal((await tenantFor("ada")).recording_render_mode, "on_demand", "Saving one account must not change another account");
  assert.equal((await tenantFor("malik")).transcript_language, "auto");
  const languageSetting = await post(malik, "/dashboard-api/developer", { action: "set-default-transcript-language", transcriptLanguage: "ur" }, other.csrfToken);
  assert.equal(languageSetting.status, 200, await languageSetting.clone().text());
  assert.deepEqual(await languageSetting.json(), { transcriptLanguage: "ur" });
  assert.equal((await tenantFor("malik")).transcript_language, "ur");
  assert.equal((await tenantFor("ada")).transcript_language, "auto", "Language changes stay in the signed-in account");
  const developerSettings = await malik.request("/dashboard-api/developer");
  assert.equal(developerSettings.status, 200);
  const otherDeveloperDTO = await developerSettings.json();
  assert.equal(otherDeveloperDTO.recordingRenderMode, "automatic");
  assert.equal(otherDeveloperDTO.transcriptLanguage, "ur");
  assert.equal(otherDeveloperDTO.tenantId, secondTenant);
  for (const action of [
    { action: "set-recording-render-mode", mode: "always" },
    { action: "set-recording-render-mode", mode: "automatic", tenantId: firstTenant },
  ]) {
    assert.equal((await post(malik, "/dashboard-api/developer", action, other.csrfToken)).status, 400);
  }
  assert.equal((await post(malik, "/dashboard-api/developer", { action: "set-recording-render-mode", mode: "on_demand" }, other.csrfToken)).status, 200);
  assert.equal((await tenantFor("malik")).recording_render_mode, "on_demand");
  console.log("PASS: dashboard recording mode persists through the real API and stays inside the signed-in Tenant");
}
