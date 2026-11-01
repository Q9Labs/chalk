package postgres

import (
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/db/migrations"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
)

func TestTranscriptLanguageMigrationAndAdmission(t *testing.T) {
	pool := automaticTranscriptMigrationPool(t)
	ctx := t.Context()
	connection, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Release()
	tenantID := mustTenantPolicyTestID(t)
	recordingID := insertTranscriptPolicyFixture(t, ctx, connection, tenantID, "on_demand", false)
	insertTranscriptSourceFixture(t, ctx, connection, tenantID, recordingID)
	exec := func(statement string, args ...any) {
		t.Helper()
		if _, err := connection.Exec(ctx, statement, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`insert into tenant_artifact_policies(tenant_id) values($1)`, tenantID.Bytes())
	// Exercise Down/Up with real pre-existing tenant, Space, and source data.
	raw, err := migrations.Files.ReadFile("20261101120000_transcript_language.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, down, ok := strings.Cut(string(raw), "-- +goose Down")
	if !ok {
		t.Fatal("missing Down")
	}
	for range 2 {
		exec(down)
		exec(up)
	}
	var mode string
	var override *string
	if err := connection.QueryRow(ctx, `select p.transcript_language,s.transcript_language from tenant_artifact_policies p join spaces s on s.tenant_id=p.tenant_id where p.tenant_id=$1`, tenantID.Bytes()).Scan(&mode, &override); err != nil || mode != "auto" || override != nil {
		t.Fatalf("migration defaults: %s %v %v", mode, override, err)
	}
	// Previous-release inserts omit the new columns and still work.
	newerTenant := mustTenantPolicyTestID(t)
	exec(`insert into tenants(id,name) values($1,'old binary')`, newerTenant.Bytes())
	exec(`insert into tenant_artifact_policies(tenant_id) values($1)`, newerTenant.Bytes())
	if err := connection.QueryRow(ctx, `select transcript_language from tenant_artifact_policies where tenant_id=$1`, newerTenant.Bytes()).Scan(&mode); err != nil || mode != "auto" {
		t.Fatalf("new tenant: %q %v", mode, err)
	}
	if _, err := connection.Exec(ctx, `update tenant_artifact_policies set transcript_language='en-US' where tenant_id=$1`, tenantID.Bytes()); err == nil {
		t.Fatal("database accepted regional code")
	}
	queries := sqlc.New(pool)
	repository := NewTranscriptRepositoryWithPool(queries, pool)
	for index, test := range []struct {
		space    *string
		explicit string
		want     string
	}{
		{nil, "", "ur"}, {stringPtr("ar"), "", "ar"}, {stringPtr("ar"), "en", "en"}, {stringPtr("ar"), "auto", "auto"}, {stringPtr("auto"), "", "auto"},
	} {
		recording := recordingID
		if index > 0 {
			recording = insertTranscriptPolicyFixture(t, ctx, connection, tenantID, "on_demand", false)
			insertTranscriptSourceFixture(t, ctx, connection, tenantID, recording)
		}
		exec(`update tenant_artifact_policies set transcript_language='ur' where tenant_id=$1`, tenantID.Bytes())
		exec(`update spaces set transcript_language=$2 where id=(select space_id from recordings where id=$1)`, recording.Bytes(), test.space)
		input := transcriptPolicyRequestInput(t, tenantID, recording, "language-"+recording.String())
		input.Language = test.explicit
		transcript, job, err := transcripts.NewService(repository).Request(ctx, input)
		if err != nil {
			t.Fatal(err)
		}
		if transcript.TranscriptLanguage.String() != test.want || job.TranscriptLanguage.String() != test.want {
			t.Fatalf("resolved transcript=%s job=%s want=%s", transcript.TranscriptLanguage.String(), job.TranscriptLanguage.String(), test.want)
		}
		// Policy changes cannot alter an existing job or its idempotent replay.
		exec(`update tenant_artifact_policies set transcript_language='en' where tenant_id=$1`, tenantID.Bytes())
		replay, replayJob, err := transcripts.NewService(repository).Request(ctx, input)
		if err != nil || replay.TranscriptLanguage != transcript.TranscriptLanguage || replayJob.TranscriptLanguage != job.TranscriptLanguage {
			t.Fatalf("replay changed mode: %v", err)
		}
		var stored string
		if err := connection.QueryRow(ctx, `select transcript_language from artifact_jobs where id=$1`, job.ID.Bytes()).Scan(&stored); err != nil || stored != test.want {
			t.Fatalf("stored job=%s want=%s error=%v", stored, test.want, err)
		}
	}
}
