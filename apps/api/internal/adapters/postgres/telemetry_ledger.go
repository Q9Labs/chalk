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

// Admit admits one version 2 batch in a single transaction and returns only after it committed,
// so the caller logs the new records and acks the batch on a durable ledger and never before. It
// locks the batch's source row and checks that the batch's participant is live (see
// lockForAdmission), runs the pure telemetrydelivery.Admit, which checks ownership and the source
// budget, then writes the row and commits. An error anywhere leaves the row as it was, so the
// retry finds its records new.
func (l TelemetryLedger) Admit(ctx context.Context, identity telemetrydelivery.Identity, batch sdktelemetry.Request, received time.Time) (telemetrydelivery.Admission, error) {
	source, err := telemetrydelivery.SourceID(batch)
	if err != nil {
		return telemetrydelivery.Admission{}, err
	}
	tx, err := l.db.Begin(ctx)
	if err != nil {
		return telemetrydelivery.Admission{}, fmt.Errorf("begin the telemetry ledger transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := sqlc.New(tx)

	existing, owned, err := lockForAdmission(ctx, queries, identity, source)
	if err != nil {
		return telemetrydelivery.Admission{}, err
	}
	admission, err := telemetrydelivery.Admit(identity, existing, owned, batch, received)
	if err != nil {
		return telemetrydelivery.Admission{}, err
	}
	if err := writeSourceRow(ctx, queries, admission.Row, existing == nil); err != nil {
		return telemetrydelivery.Admission{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return telemetrydelivery.Admission{}, fmt.Errorf("commit the telemetry ledger: %w", err)
	}
	return admission, nil
}

// lockForAdmission returns the batch's source row, locked, or nil when there is none, with the
// number of sources the participant owns when the row is new. It refuses with
// telemetrydelivery.ErrParticipantGone unless the participant's row exists in the credential's
// tenant and Episode.
//
// The table lock comes first so that a tenant purge and an admission never interleave (see the
// LockTelemetrySourceTable query). The participant row is then held against deletion, and for a
// new source it is locked for update, which queues the source creations of one participant: the
// one that waited reads the row again, since a creation it waited for may have made it.
func lockForAdmission(ctx context.Context, queries *sqlc.Queries, identity telemetrydelivery.Identity, source utilities.ID) (*telemetrydelivery.SourceRow, int, error) {
	if err := queries.LockTelemetrySourceTable(ctx); err != nil {
		return nil, 0, fmt.Errorf("lock the telemetry source table: %w", err)
	}
	existing, err := lockSourceRow(ctx, queries, identity.TenantID, source)
	if err != nil {
		return nil, 0, err
	}
	participant := sqlc.TelemetryParticipantLiveParams{TenantID: uuid(identity.TenantID), EpisodeID: uuid(identity.EpisodeID), ID: uuid(identity.ParticipantID)}
	if existing != nil {
		live, err := queries.TelemetryParticipantLive(ctx, participant)
		return existing, 0, liveness(live, err)
	}
	live, err := queries.LockTelemetryParticipant(ctx, sqlc.LockTelemetryParticipantParams(participant))
	if err := liveness(live, err); err != nil {
		return nil, 0, err
	}
	if existing, err := lockSourceRow(ctx, queries, identity.TenantID, source); err != nil || existing != nil {
		return existing, 0, err
	}
	owned, err := queries.CountTelemetryParticipantSources(ctx, sqlc.CountTelemetryParticipantSourcesParams{TenantID: uuid(identity.TenantID), ParticipantID: uuid(identity.ParticipantID)})
	if err != nil {
		return nil, 0, fmt.Errorf("count the telemetry participant's sources: %w", err)
	}
	return nil, int(owned), nil
}

// Live returns telemetrydelivery.ErrParticipantGone unless the participant's row exists in the
// credential's tenant and Episode, the same check Admit makes. A version 1 batch writes no ledger
// row, so nothing is held after the check; a tenant purge removes the participant row, so a
// credential of a purged tenant fails it from the moment the purge commits.
func (l TelemetryLedger) Live(ctx context.Context, identity telemetrydelivery.Identity) error {
	live, err := sqlc.New(l.db).TelemetryParticipantLive(ctx, sqlc.TelemetryParticipantLiveParams{TenantID: uuid(identity.TenantID), EpisodeID: uuid(identity.EpisodeID), ID: uuid(identity.ParticipantID)})
	return liveness(live, err)
}

func liveness(live []pgtype.UUID, err error) error {
	if err != nil {
		return fmt.Errorf("check the telemetry participant: %w", err)
	}
	if len(live) == 0 {
		return telemetrydelivery.ErrParticipantGone
	}
	return nil
}

func lockSourceRow(ctx context.Context, queries *sqlc.Queries, tenant, source utilities.ID) (*telemetrydelivery.SourceRow, error) {
	locked, err := queries.LockTelemetrySource(ctx, sqlc.LockTelemetrySourceParams{TenantID: uuid(tenant), SourceID: uuid(source)})
	if err != nil {
		return nil, fmt.Errorf("lock the telemetry source row: %w", err)
	}
	if len(locked) == 0 {
		return nil, nil
	}
	row, err := telemetrySourceRow(locked[0])
	return &row, err
}

// writeSourceRow inserts a new row or updates the locked one. An insert that meets a row another
// participant created and committed meanwhile is refused as owned: the participant lock queues the
// creations of one participant, so the row is never this participant's own.
func writeSourceRow(ctx context.Context, queries *sqlc.Queries, row telemetrydelivery.SourceRow, isNew bool) error {
	ranges, err := json.Marshal(row.Ranges)
	if err != nil {
		return fmt.Errorf("encode the telemetry ranges: %w", err)
	}
	endState := pgtype.Text{String: string(row.End), Valid: row.End != telemetrydelivery.EndNone}
	endNextSeq := pgtype.Int8{Int64: row.EndNextSeq, Valid: row.End != telemetrydelivery.EndNone}
	last := pgtype.Timestamptz{Time: row.LastReceivedAt, Valid: true}
	if !isNew {
		err := queries.UpdateTelemetrySource(ctx, sqlc.UpdateTelemetrySourceParams{
			TenantID: uuid(row.TenantID), SourceID: uuid(row.SourceID),
			Ranges: ranges, ReportedNextSeq: row.ReportedNextSeq, EndState: endState, EndNextSeq: endNextSeq, LastReceivedAt: last,
		})
		if err != nil {
			return fmt.Errorf("update the telemetry source row: %w", err)
		}
		return nil
	}
	inserted, err := queries.InsertTelemetrySource(ctx, sqlc.InsertTelemetrySourceParams{
		TenantID: uuid(row.TenantID), SourceID: uuid(row.SourceID), ParticipantID: uuid(row.ParticipantID), EpisodeID: uuid(row.EpisodeID),
		Ranges: ranges, ReportedNextSeq: row.ReportedNextSeq, EndState: endState, EndNextSeq: endNextSeq,
		FirstReceivedAt: pgtype.Timestamptz{Time: row.FirstReceivedAt, Valid: true}, LastReceivedAt: last,
	})
	if err != nil {
		return fmt.Errorf("create the telemetry source row: %w", err)
	}
	if inserted == 0 {
		return telemetrydelivery.ErrSourceOwned
	}
	return nil
}

// Source returns the row of one source and whether there is one. Pass it to telemetrydelivery.Gaps.
func (l TelemetryLedger) Source(ctx context.Context, tenant, source utilities.ID) (telemetrydelivery.SourceRow, bool, error) {
	stored, err := sqlc.New(l.db).GetTelemetrySource(ctx, sqlc.GetTelemetrySourceParams{TenantID: uuid(tenant), SourceID: uuid(source)})
	if err != nil {
		return telemetrydelivery.SourceRow{}, false, fmt.Errorf("read the telemetry source row: %w", err)
	}
	if len(stored) == 0 {
		return telemetrydelivery.SourceRow{}, false, nil
	}
	row, err := telemetrySourceRow(stored[0])
	return row, err == nil, err
}

// Episode returns the row of every source the Episode's participants own, ordered by source. Pass
// each to telemetrydelivery.Gaps.
func (l TelemetryLedger) Episode(ctx context.Context, tenant, episode utilities.ID) ([]telemetrydelivery.SourceRow, error) {
	stored, err := sqlc.New(l.db).ListTelemetryEpisodeRows(ctx, sqlc.ListTelemetryEpisodeRowsParams{TenantID: uuid(tenant), EpisodeID: uuid(episode)})
	if err != nil {
		return nil, fmt.Errorf("read the telemetry Episode rows: %w", err)
	}
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
