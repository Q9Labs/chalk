package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
	"github.com/q9labs/chalk/apps/api/internal/telemetrydelivery"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type telemetryLedgerDB interface {
	sqlc.DBTX
	Begin(context.Context) (pgx.Tx, error)
}

// TelemetryLedger is the stored telemetry ledger (table telemetry_sources).
type TelemetryLedger struct {
	db telemetryLedgerDB
}

func NewTelemetryLedger(db telemetryLedgerDB) TelemetryLedger {
	return TelemetryLedger{db: db}
}

// Admit admits one version 2 batch in a single transaction. It creates the rows of the sources the
// batch touches when they are missing, locks them (FOR UPDATE, in source order, so concurrent
// batches of one source queue behind each other and cannot deadlock), runs the pure
// telemetrydelivery.Admit, calls write so the caller can write the sink rows of the new records,
// and only then updates the rows and commits. An error anywhere, including a crash between write
// and commit, leaves the rows as they were, so the retry finds its records new and writes them
// again with the same event ids.
func (l TelemetryLedger) Admit(ctx context.Context, identity telemetrydelivery.Identity, batch sdktelemetry.Request, received time.Time, write telemetrydelivery.SinkWrite) (telemetrydelivery.Admission, error) {
	sources, err := telemetrydelivery.Sources(batch)
	if err != nil {
		return telemetrydelivery.Admission{}, err
	}
	tx, err := l.db.Begin(ctx)
	if err != nil {
		return telemetrydelivery.Admission{}, fmt.Errorf("begin the telemetry ledger transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := sqlc.New(tx)

	ids := make([]pgtype.UUID, 0, len(sources))
	for _, source := range sources {
		ids = append(ids, uuid(source))
		err := queries.EnsureTelemetrySource(ctx, sqlc.EnsureTelemetrySourceParams{
			TenantID: uuid(identity.TenantID), SourceID: uuid(source), ParticipantID: uuid(identity.ParticipantID), EpisodeID: uuid(identity.EpisodeID),
			FirstReceivedAt: pgtype.Timestamptz{Time: received, Valid: true},
		})
		if err != nil {
			return telemetrydelivery.Admission{}, fmt.Errorf("create the telemetry source row: %w", err)
		}
	}
	locked, err := queries.LockTelemetrySources(ctx, sqlc.LockTelemetrySourcesParams{TenantID: uuid(identity.TenantID), ParticipantID: uuid(identity.ParticipantID), SourceIds: ids})
	if err != nil {
		return telemetrydelivery.Admission{}, fmt.Errorf("lock the telemetry source rows: %w", err)
	}
	rows := make(map[utilities.ID]telemetrydelivery.SourceRow, len(locked))
	for _, stored := range locked {
		row, err := telemetrySourceRow(stored)
		if err != nil {
			return telemetrydelivery.Admission{}, err
		}
		rows[row.SourceID] = row
	}

	admission, err := telemetrydelivery.Admit(identity, rows, batch, received)
	if err != nil {
		return telemetrydelivery.Admission{}, err
	}
	if err := write(ctx, admission); err != nil {
		return telemetrydelivery.Admission{}, fmt.Errorf("write the telemetry sink rows: %w", err)
	}
	for _, row := range admission.Rows {
		ranges, err := json.Marshal(row.Ranges)
		if err != nil {
			return telemetrydelivery.Admission{}, fmt.Errorf("encode the telemetry ranges: %w", err)
		}
		err = queries.UpdateTelemetrySource(ctx, sqlc.UpdateTelemetrySourceParams{
			TenantID: uuid(row.TenantID), SourceID: uuid(row.SourceID), ParticipantID: uuid(row.ParticipantID),
			Ranges: ranges, ReportedNextSeq: row.ReportedNextSeq,
			EndState:       pgtype.Text{String: string(row.End), Valid: row.End != telemetrydelivery.EndNone},
			EndNextSeq:     pgtype.Int8{Int64: row.EndNextSeq, Valid: row.End != telemetrydelivery.EndNone},
			LastReceivedAt: pgtype.Timestamptz{Time: row.LastReceivedAt, Valid: true},
		})
		if err != nil {
			return telemetrydelivery.Admission{}, fmt.Errorf("update the telemetry source row: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return telemetrydelivery.Admission{}, fmt.Errorf("commit the telemetry ledger: %w", err)
	}
	return admission, nil
}

// Source returns the rows of one source, one per participant. Pass them to telemetrydelivery.Gaps.
func (l TelemetryLedger) Source(ctx context.Context, tenant, source utilities.ID) ([]telemetrydelivery.SourceRow, error) {
	stored, err := sqlc.New(l.db).ListTelemetrySourceRows(ctx, sqlc.ListTelemetrySourceRowsParams{TenantID: uuid(tenant), SourceID: uuid(source)})
	if err != nil {
		return nil, fmt.Errorf("read the telemetry source rows: %w", err)
	}
	return telemetrySourceRows(stored)
}

// Episode returns the rows of every source that sent records for the Episode, ordered by source.
// Group them by SourceID and pass each group to telemetrydelivery.Gaps.
func (l TelemetryLedger) Episode(ctx context.Context, tenant, episode utilities.ID) ([]telemetrydelivery.SourceRow, error) {
	stored, err := sqlc.New(l.db).ListTelemetryEpisodeRows(ctx, sqlc.ListTelemetryEpisodeRowsParams{TenantID: uuid(tenant), EpisodeID: uuid(episode)})
	if err != nil {
		return nil, fmt.Errorf("read the telemetry Episode rows: %w", err)
	}
	return telemetrySourceRows(stored)
}

func telemetrySourceRows(stored []sqlc.TelemetrySource) ([]telemetrydelivery.SourceRow, error) {
	rows := make([]telemetrydelivery.SourceRow, 0, len(stored))
	for _, item := range stored {
		row, err := telemetrySourceRow(item)
		if err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func telemetrySourceRow(stored sqlc.TelemetrySource) (telemetrydelivery.SourceRow, error) {
	var ranges telemetrydelivery.Ranges
	if err := json.Unmarshal(stored.Ranges, &ranges); err != nil {
		return telemetrydelivery.SourceRow{}, fmt.Errorf("decode the telemetry ranges: %w", err)
	}
	row := telemetrydelivery.SourceRow{
		TenantID: nullableID(stored.TenantID), SourceID: nullableID(stored.SourceID), ParticipantID: nullableID(stored.ParticipantID), EpisodeID: nullableID(stored.EpisodeID),
		Ranges: ranges.Normalized(), ReportedNextSeq: stored.ReportedNextSeq,
		FirstReceivedAt: timestamp(stored.FirstReceivedAt), LastReceivedAt: timestamp(stored.LastReceivedAt),
	}
	if stored.EndState.Valid {
		row.End, row.EndNextSeq = telemetrydelivery.EndState(stored.EndState.String), stored.EndNextSeq.Int64
	}
	return row, nil
}
