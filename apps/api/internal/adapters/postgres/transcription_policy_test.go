package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRequestRejectsDisabledTranscriptionBeforeOpeningTransaction(t *testing.T) {
	for _, test := range []struct {
		name string
		mode string
	}{
		{name: "disabled", mode: "disabled"},
		{name: "legacy missing mode", mode: ""},
		{name: "unknown mode", mode: "legacy"},
	} {
		t.Run(test.name, func(t *testing.T) {
			queries := &transcriptionPolicyQueries{mode: test.mode}
			transactor := &transcriptionPolicyTransactor{}
			repository := TranscriptRepository{queries: queries, transactor: transactor}

			_, _, err := repository.Request(context.Background(), transcriptionPolicyRequestInput(t))
			if !errors.Is(err, transcripts.ErrTranscriptionDisabled) {
				t.Fatalf("request error = %v, want ErrTranscriptionDisabled", err)
			}
			if transactor.began {
				t.Fatal("disabled transcription opened a creation transaction")
			}
		})
	}
}

func TestRequestAllowsSupportedTranscriptionModesToReachCreation(t *testing.T) {
	for _, mode := range []string{"on_demand", "automatic"} {
		t.Run(mode, func(t *testing.T) {
			transactor := &transcriptionPolicyTransactor{}
			repository := TranscriptRepository{queries: &transcriptionPolicyQueries{mode: mode}, transactor: transactor}

			_, _, err := repository.Request(context.Background(), transcriptionPolicyRequestInput(t))
			if err == nil || !transactor.began {
				t.Fatalf("request error = %v, began = %t, want transaction begin after policy approval", err, transactor.began)
			}
			if errors.Is(err, transcripts.ErrTranscriptionDisabled) {
				t.Fatalf("supported mode was rejected as disabled: %v", err)
			}
		})
	}
}

func TestRequestReturnsIdempotentTranscriptBeforeReadingPolicy(t *testing.T) {
	transcriptID := mustPolicyTestID(t, "00000000-0000-4000-8000-000000000002")
	jobID := mustPolicyTestID(t, "00000000-0000-4000-8000-000000000003")
	queries := &transcriptionPolicyQueries{
		mode: "disabled",
		idempotencyJob: sqlc.ArtifactJob{
			ID:             uuid(jobID),
			TenantID:       uuid(mustPolicyTestID(t, "00000000-0000-4000-8000-000000000001")),
			TranscriptID:   uuid(transcriptID),
			IdempotencyKey: "request-00000001",
		},
	}
	transactor := &transcriptionPolicyTransactor{}
	repository := TranscriptRepository{queries: queries, transactor: transactor}

	transcript, job, err := repository.Request(context.Background(), transcriptionPolicyRequestInput(t))
	if err != nil {
		t.Fatalf("idempotent request error = %v", err)
	}
	if transcript.ID != transcriptID || job.ID != jobID {
		t.Fatalf("idempotent result = transcript %s, job %s; want %s, %s", transcript.ID, job.ID, transcriptID, jobID)
	}
	if queries.policyReads != 0 {
		t.Fatalf("idempotent replay read policy %d times, want 0", queries.policyReads)
	}
	if transactor.began {
		t.Fatal("idempotent replay opened a creation transaction")
	}
}

type transcriptionPolicyQueries struct {
	mode           string
	policyReads    int
	idempotencyJob sqlc.ArtifactJob
}

func (q *transcriptionPolicyQueries) CreateTranscription(context.Context, sqlc.CreateTranscriptionParams) (sqlc.Transcription, error) {
	return sqlc.Transcription{}, errors.New("unexpected CreateTranscription")
}

func (q *transcriptionPolicyQueries) GetTenantTranscription(context.Context, sqlc.GetTenantTranscriptionParams) (sqlc.Transcription, error) {
	if !q.idempotencyJob.ID.Valid {
		return sqlc.Transcription{}, pgx.ErrNoRows
	}
	return sqlc.Transcription{ID: q.idempotencyJob.TranscriptID, TenantID: q.idempotencyJob.TenantID}, nil
}

func (*transcriptionPolicyQueries) GetTenantTranscriptionByRecording(context.Context, sqlc.GetTenantTranscriptionByRecordingParams) (sqlc.Transcription, error) {
	return sqlc.Transcription{}, pgx.ErrNoRows
}

func (q *transcriptionPolicyQueries) GetCompletedRecordingTranscriptionMode(context.Context, sqlc.GetCompletedRecordingTranscriptionModeParams) (string, error) {
	q.policyReads++
	return q.mode, nil
}

func (*transcriptionPolicyQueries) GetTranscriptionChunkJob(context.Context, pgtype.UUID) (sqlc.ArtifactJob, error) {
	return sqlc.ArtifactJob{}, pgx.ErrNoRows
}

func (*transcriptionPolicyQueries) ListTenantTranscriptions(context.Context, sqlc.ListTenantTranscriptionsParams) ([]sqlc.Transcription, error) {
	return nil, nil
}

func (*transcriptionPolicyQueries) UpdateTenantTranscription(context.Context, sqlc.UpdateTenantTranscriptionParams) (sqlc.Transcription, error) {
	return sqlc.Transcription{}, errors.New("unexpected UpdateTenantTranscription")
}

func (*transcriptionPolicyQueries) FinalizeTranscription(context.Context, sqlc.FinalizeTranscriptionParams) (sqlc.Transcription, error) {
	return sqlc.Transcription{}, errors.New("unexpected FinalizeTranscription")
}

func (q *transcriptionPolicyQueries) GetArtifactJobByIdempotency(context.Context, sqlc.GetArtifactJobByIdempotencyParams) (sqlc.ArtifactJob, error) {
	if !q.idempotencyJob.ID.Valid {
		return sqlc.ArtifactJob{}, pgx.ErrNoRows
	}
	return q.idempotencyJob, nil
}

type transcriptionPolicyTransactor struct {
	began bool
}

func (t *transcriptionPolicyTransactor) Begin(context.Context) (pgx.Tx, error) {
	t.began = true
	return nil, errors.New("policy test transaction")
}

func transcriptionPolicyRequestInput(t *testing.T) transcripts.RequestInput {
	t.Helper()
	return transcripts.RequestInput{
		TenantID:       mustPolicyTestID(t, "00000000-0000-4000-8000-000000000001"),
		RecordingID:    mustPolicyTestID(t, "00000000-0000-4000-8000-000000000004"),
		IdempotencyKey: "request-00000001",
	}
}

func mustPolicyTestID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
