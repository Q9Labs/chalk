package postgres_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
)

// A Space's transcript language is what the Space's next transcript is produced in: the Recording's lookup returns it,
// and it wins over the tenant default unless the request names a language itself.
func TestRecordingTranscriptLanguageFollowsItsSpace(t *testing.T) {
	tx, fixture := newAllocationCleanupFixture(t, false, "capture")
	ctx := context.Background()
	defer tx.Rollback(ctx)
	execCleanupFixture(t, tx, `insert into tenant_artifact_policies (tenant_id) select tenant_id from recordings where id = $1 on conflict do nothing`, fixture.recordingID.Bytes())
	var tenantID pgtype.UUID
	if err := tx.QueryRow(ctx, `select tenant_id from recordings where id = $1`, fixture.recordingID.Bytes()).Scan(&tenantID); err != nil {
		t.Fatal(err)
	}
	read := func() sqlc.GetRecordingTranscriptLanguageRow {
		t.Helper()
		row, err := sqlc.New(tx).GetRecordingTranscriptLanguage(ctx, sqlc.GetRecordingTranscriptLanguageParams{TenantID: tenantID, RecordingID: pgtype.UUID{Bytes: fixture.recordingID.Bytes(), Valid: true}})
		if err != nil {
			t.Fatal(err)
		}
		return row
	}
	tenantDefault := artifactpolicy.TranscriptLanguage{}
	if read().SpaceTranscriptLanguage.Valid {
		t.Fatal("a new Space has no language of its own")
	}
	for _, code := range []string{"fr", "ar", "auto"} {
		execCleanupFixture(t, tx, `update spaces set transcript_language = $1 where id = (select space_id from recordings where id = $2)`, code, fixture.recordingID.Bytes())
		row := read()
		if !row.SpaceTranscriptLanguage.Valid || row.SpaceTranscriptLanguage.String != code {
			t.Fatalf("Space language %q read back as %+v", code, row.SpaceTranscriptLanguage)
		}
		space, err := artifactpolicy.ParseTranscriptLanguage(row.SpaceTranscriptLanguage.String)
		if err != nil {
			t.Fatal(err)
		}
		if got := artifactpolicy.ResolveTranscriptLanguage(nil, &space, tenantDefault); got != space {
			t.Fatalf("Space %q resolved to %q", code, got.String())
		}
	}
}
