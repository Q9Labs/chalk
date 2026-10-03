package postgres

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
)

func snapshotPurgeWriteDrain(ctx context.Context, tx purgeQueryer, catalog purgeCatalog, selected map[string]string, ids []string) (*tenantpurge.WriteDrain, error) {
	var deadlines []string
	for _, table := range catalog.Tables {
		condition := selected[table.Name]
		if condition == "" {
			continue
		}
		for _, column := range table.Columns {
			lease := strings.HasSuffix(column.Name, "execution_expires_at") || (column.Name == "lease_expires_at" && (table.Name == "artifact_jobs" || strings.HasPrefix(table.Name, "recording_") || strings.HasPrefix(table.Name, "transcription_")))
			upload := column.Name == "upload_expires_at" || (column.Name == "expires_at" && (table.Name == "recording_bundle_allocations" || table.Name == "sync_chat_attachments" || table.Name == "sync_whiteboard_files"))
			if column.Type != "timestamp with time zone" || (!lease && !upload) {
				continue
			}
			deadlines = append(deadlines, `select max(`+purgeQuote(column.Name)+`) as deadline from `+purgeName(table.Name)+` where `+condition)
		}
		if table.Name == "artifact_jobs" {
			// Completion clears lease_expires_at, but the issued PUT URL lives
			// until its original maximum TTL, bounded from the later update.
			deadlines = append(deadlines, `select max(updated_at)+make_interval(secs => `+fmt.Sprint(transcripts.WorkLeaseDuration.Seconds())+`) as deadline from `+purgeName(table.Name)+` where (`+condition+`) and artifact_kind in ('transcription_chunk','transcription_finalize')`)
		}
	}
	drain := &tenantpurge.WriteDrain{}
	if len(deadlines) == 0 {
		return drain, nil
	}
	var latest pgtype.Timestamptz
	if err := tx.QueryRow(ctx, `select max(deadline) from (`+strings.Join(deadlines, ` union all `)+`) deadlines`, ids).Scan(&latest); err != nil {
		return nil, err
	}
	if latest.Valid {
		// Product R2 requests are bounded; leave two minutes beyond the last
		// persisted upload/lease expiry for already-started requests to drain.
		drain.NotBefore = latest.Time.UTC().Add(2 * time.Minute)
	}
	return drain, nil
}
