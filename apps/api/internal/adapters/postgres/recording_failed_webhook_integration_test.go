package postgres_test

import "testing"

// A capture whose lease ran out for the last time never reaches Fail, so recovery is the only
// path that can tell a subscriber the Recording failed.
func TestLeaseRecoveryPublishesTheRecordingFailedWebhook(t *testing.T) {
	ctx := t.Context()
	tx, f := newAllocationCleanupFixture(t, true, "capture")
	defer tx.Rollback(ctx)
	execCleanupFixture(t, tx, `update recording_jobs set attempt_limit = 1 where id = $1`, f.jobID.Bytes())
	execCleanupFixture(t, tx, `update recording_capacity set reserved_episodes = reserved_episodes + 1,
		reserved_participants = reserved_participants + 1, reserved_input_bitrate_bps = reserved_input_bitrate_bps + 1000 where id = 1`)
	execCleanupFixture(t, tx, `update recordings set status = 'pending' where id = $1`, f.recordingID.Bytes())
	execCleanupFixture(t, tx, `insert into webhook_endpoints (id, tenant_id, name, enabled, revision, current_target_revision, current_secret_ciphertext)
		select gen_random_uuid(), tenant_id, 'recovery subscriber', true, 1, 1, '\x01' from recordings where id = $1`, f.recordingID.Bytes())
	execCleanupFixture(t, tx, `insert into webhook_endpoint_revisions (id, tenant_id, endpoint_id, revision, url_ciphertext, url_redacted, api_version, event_types)
		select gen_random_uuid(), tenant_id, id, 1, '\x01', 'https://subscriber.invalid', 1, array['recording.failed'] from webhook_endpoints
		where tenant_id = (select tenant_id from recordings where id = $1)`, f.recordingID.Bytes())

	if _, err := transactionalPipelineRepository(tx).RecoverExpired(ctx); err != nil {
		t.Fatalf("recover expired: %v", err)
	}
	var events int
	var code string
	if err := tx.QueryRow(ctx, `select count(*), coalesce(max(convert_from(body, 'UTF8')::jsonb #>> '{data,object,failure,code}'), '')
		from webhook_events where resource_id = $1 and event_name = 'recording.failed'`, f.recordingID.Bytes()).Scan(&events, &code); err != nil {
		t.Fatal(err)
	}
	facts := readRecordingFacts(t, tx, f.recordingID)
	if events != 1 || facts.failureCode == nil || code != *facts.failureCode {
		t.Fatalf("recovery must publish one recording.failed carrying the stored code: events=%d webhook_code=%q facts=%+v", events, code, facts)
	}
}
