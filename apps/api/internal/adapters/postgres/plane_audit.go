package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"go.opentelemetry.io/otel/trace"
)

// publicChangeReason is the reason recorded for a change that came through the public API,
// which has an actor and no free-text reason.
const publicChangeReason = "public API request"

// tagPlaneChange tells the plane audit triggers who is writing and why, for the rest of
// the transaction. The triggers write the row (see migration media_plane_changes), so
// every writer is audited, and this call only names the writer. A caller with an operator
// origin in ctx uses it; a request with a principal is named after its credential; any
// other writer stays "unattributed".
func tagPlaneChange(ctx context.Context, tx pgx.Tx) error {
	origin, ok := mediaplane.ChangeOriginFrom(ctx)
	if !ok {
		origin = principalOrigin(ctx)
	}
	if origin.Actor == "" {
		return nil
	}
	if origin.TraceID == "" {
		if span := trace.SpanContextFromContext(ctx); span.IsValid() {
			origin.TraceID = span.TraceID().String()
		}
	}
	if _, err := tx.Exec(ctx, `select set_config('chalk.plane_actor', $1, true), set_config('chalk.plane_reason', $2, true), set_config('chalk.plane_trace_id', $3, true)`,
		origin.Actor, origin.Reason, origin.TraceID); err != nil {
		return fmt.Errorf("name the writer of a media plane change: %w", err)
	}
	return nil
}

func principalOrigin(ctx context.Context) mediaplane.ChangeOrigin {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok {
		return mediaplane.ChangeOrigin{}
	}
	var actor string
	switch principal.Kind {
	case authentication.PrincipalUser:
		actor = "user:" + principal.UserID.String()
	case authentication.PrincipalAPIKey:
		actor = "api_key:" + principal.APIKeyID.String()
	case authentication.PrincipalOAuth:
		actor = "oauth:" + principal.GrantID.String()
	case authentication.PrincipalService:
		actor = "service:" + principal.ServiceID
	case authentication.PrincipalSystem:
		actor = "system"
	default:
		return mediaplane.ChangeOrigin{}
	}
	return mediaplane.ChangeOrigin{Actor: actor, Reason: publicChangeReason}
}

// ChangeLedger reads the audit trail of plane changes for the relay that announces them.
type ChangeLedger struct {
	pool *pgxpool.Pool
}

func NewChangeLedger(pool *pgxpool.Pool) ChangeLedger {
	return ChangeLedger{pool: pool}
}

// AnnounceChanges claims the changes that no replica has announced, skipping rows another
// replica holds, calls announce for each, and marks them announced when the transaction
// commits.
func (l ChangeLedger) AnnounceChanges(ctx context.Context, limit int, announce func(mediaplane.Change)) (int, error) {
	tx, err := l.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("claim media plane changes: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := sqlc.New(tx)
	rows, err := queries.ClaimUnemittedMediaPlaneChanges(ctx, int32(limit))
	if err != nil {
		return 0, fmt.Errorf("claim media plane changes: %w", err)
	}
	if len(rows) == 0 {
		return 0, nil
	}
	ids := make([]int64, len(rows))
	for i, row := range rows {
		ids[i] = row.ID
		announce(mediaplane.Change{
			ID:        row.ID,
			ChangedAt: row.ChangedAt.Time,
			Scope:     mediaplane.ChangeScope(row.Scope),
			TenantID:  nullableID(row.TenantID),
			SpaceID:   nullableID(row.SpaceID),
			OldPlane:  row.OldPlane,
			NewPlane:  row.NewPlane,
			Actor:     row.Actor,
			Reason:    row.Reason,
			TraceID:   row.TraceID.String,
		})
	}
	if err := queries.MarkMediaPlaneChangesEmitted(ctx, ids); err != nil {
		return 0, fmt.Errorf("mark media plane changes announced: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit media plane change announcements: %w", err)
	}
	return len(rows), nil
}

// announceEpisodeBinding emits the plane decision of an Episode that just committed. Its
// three birth flows call it after their transaction, so a rolled-back creation announces
// nothing. An Episode without a binding has no plane to announce.
func announceEpisodeBinding(ctx context.Context, episode episodes.Episode) {
	binding, _, err := episode.MediaPlaneBinding()
	if err != nil || binding == nil {
		return
	}
	observability.LogMediaPlaneSelected(ctx, episode.TenantID, episode.SpaceID, episode.ID, *binding)
}
