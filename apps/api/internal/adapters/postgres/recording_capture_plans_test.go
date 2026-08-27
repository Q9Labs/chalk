package postgres

import (
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestBuildRecordingCapturePlanUsesFoldedIdentityAndDurableGeneration(t *testing.T) {
	source, input, deadline := capturePlanSourceFixture(t)
	plan, err := buildRecordingCapturePlan(source, input, 1, deadline.Add(-time.Minute))
	if err != nil {
		t.Fatalf("build capture plan: %v", err)
	}
	participants := plan.Participants()
	if len(participants) != 1 || participants[0].DisplayName != "Capture Participant" || participants[0].Generation != 7 || participants[0].JoinOrdinal != 4 {
		t.Fatalf("participants = %#v", participants)
	}
	if plan.StopState() != captureplan.StopStateRunning || !plan.EffectiveDeadline().Equal(deadline) {
		t.Fatalf("plan stop/deadline = %s %s", plan.StopState(), plan.EffectiveDeadline())
	}
	if plan.Cursors() != (captureplan.PlanCursors{EpisodeControlRevision: 4, ProviderIncarnation: 2, ProviderSequence: 3}) {
		t.Fatalf("plan cursors = %#v", plan.Cursors())
	}
}

func TestBuildRecordingCapturePlanStopsAtHardDeadlineAndIgnoresDisabledDepartedPublication(t *testing.T) {
	source, input, deadline := capturePlanSourceFixture(t)
	source.ProviderPublications = []byte(`[{"participant_id":"77777777-7777-4777-8777-777777777777","source":"camera","enabled":false,"publication_id":null}]`)
	plan, err := buildRecordingCapturePlan(source, input, 1, deadline)
	if err != nil {
		t.Fatalf("build deadline capture plan: %v", err)
	}
	if plan.StopState() != captureplan.StopStateRequested || !plan.StopRequestedAt().Equal(deadline) || len(plan.Tracks()) != 0 {
		t.Fatalf("deadline plan = state %s requested %s tracks %#v", plan.StopState(), plan.StopRequestedAt(), plan.Tracks())
	}
}

func TestBuildRecordingCapturePlanRejectsEnvelopeAuthorityMismatch(t *testing.T) {
	source, input, deadline := capturePlanSourceFixture(t)
	input.PlanHandle = captureplan.PlanHandle("88888888-8888-4888-8888-888888888888")
	if _, err := buildRecordingCapturePlan(source, input, 1, deadline.Add(-time.Minute)); !errors.Is(err, captureplan.ErrPlanAuthorityMismatch) {
		t.Fatalf("authority mismatch error = %v, want %v", err, captureplan.ErrPlanAuthorityMismatch)
	}
}

func capturePlanSourceFixture(t *testing.T) (sqlc.GetRecordingCapturePlanSourceRow, captureplan.WaitInput, time.Time) {
	t.Helper()
	tenantID := capturePlanID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := capturePlanID(t, "22222222-2222-4222-8222-222222222222")
	episodeID := capturePlanID(t, "33333333-3333-4333-8333-333333333333")
	recordingID := capturePlanID(t, "44444444-4444-4444-8444-444444444444")
	jobID := capturePlanID(t, "55555555-5555-4555-8555-555555555555")
	claimRequestID := capturePlanID(t, "66666666-6666-4666-8666-666666666666")
	participantID := capturePlanID(t, "77777777-7777-4777-8777-777777777777")
	deadline := time.Date(2026, 8, 25, 13, 0, 0, 0, time.UTC)
	job := recordingpipeline.Job{
		ID: jobID, TenantID: tenantID, EpisodeID: episodeID, RecordingID: recordingID,
		Kind: recordingpipeline.JobKindCapture, AttemptCount: 1, FencingGeneration: 2, CaptureEpoch: 1,
	}
	authority, err := recordingpipeline.NewRecorderJobAuthority(job, recordingpipeline.ClaimFacts{
		SpaceID: spaceID, PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion,
		HardDeadline: deadline, CaptureEpoch: 1,
	}, claimRequestID, deadline.Add(-time.Hour))
	if err != nil {
		t.Fatalf("build recorder authority: %v", err)
	}
	input := captureplan.NewWaitInput(captureplan.PlanAuthority{
		PlanHandle: captureplan.PlanHandle(authority.Envelope.PlanHandle), TenantID: tenantID,
		SpaceID: spaceID, EpisodeID: episodeID, RecordingID: recordingID, JobID: jobID,
		AttemptCount: 1, FencingGeneration: 2, CaptureEpoch: captureplane.CaptureEpoch(1),
		EnvelopeDigest: authority.EnvelopeDigest,
	}, captureplan.WorkerLease{Owner: "capture-worker", Token: "capture-lease", ExpiresAt: deadline.Add(time.Minute)}, 0, time.Second)
	return sqlc.GetRecordingCapturePlanSourceRow{
		EnvelopeBytes: authority.EnvelopeBytes, EnvelopeDigest: authority.EnvelopeDigest,
		JobID: uuid(jobID), TenantID: uuid(tenantID), SpaceID: uuid(spaceID), EpisodeID: uuid(episodeID), RecordingID: uuid(recordingID),
		AttemptCount: 1, FencingGeneration: 2, CaptureEpoch: 1,
		ParticipantCount: 10, InputBitrateBps: 4_000_000,
		EndsAt: pgtype.Timestamptz{Time: deadline, Valid: true}, PipelineState: "capture_leased",
		EpisodeControlRevision: 4,
		EpisodeFoldedState:     []byte(`{"control_revision":4,"status":"active","participants":[{"participant_id":"` + participantID.String() + `","display_name":"Capture Participant","admission_revision":4}]}`),
		EpisodeParticipants:    []byte(`[{"participant_id":"` + participantID.String() + `","generation":7,"status":"active"}]`),
		ProviderIncarnation:    2, ProviderSequence: 3, ProviderPublications: []byte(`[]`),
	}, input, deadline
}

func capturePlanID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
