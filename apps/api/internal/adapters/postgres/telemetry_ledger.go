package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
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

// TelemetryLedger is the stored telemetry ledger (tables telemetry_sources and
// telemetry_source_bindings).
type TelemetryLedger struct {
	db telemetryLedgerDB
}

func NewTelemetryLedger(db telemetryLedgerDB) TelemetryLedger {
	return TelemetryLedger{db: db}
}

// Admit admits one version 2 batch in a single transaction. It first binds every source the batch
// touches that has no binding yet to the batch's participant, and refuses the batch with
// telemetrydelivery.ErrSourceBound when the batch's own source is bound to a participant this one
// does not succeed (see bindSources). A predecessor bound to such a participant is barred: it gets
// no row and no lock, and the drop record naming it is settled in the own source as rejected. It
// then creates the rows of the other sources when they are missing, locks them (FOR UPDATE, in
// source order, so concurrent batches of one source queue behind each other and cannot deadlock),
// runs the pure telemetrydelivery.Admit, calls write so the caller can write the sink rows of the
// new records, and only then updates the rows and commits. An error anywhere, including a crash
// between write and commit, leaves the rows as they were, so the retry finds its records new and
// writes them again with the same event ids.
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

	own, _ := utilities.ParseID(batch.SourceID)
	barred, err := bindSources(ctx, queries, identity, own, sources, received)
	if err != nil {
		return telemetrydelivery.Admission{}, err
	}
	// A barred predecessor gets no row and no lock: the batch changes nothing in it.
	writable := slices.DeleteFunc(slices.Clone(sources), func(source utilities.ID) bool { return slices.Contains(barred, source) })
	ids := make([]pgtype.UUID, 0, len(writable))
	for _, source := range writable {
		ids = append(ids, uuid(source))
	}
	for _, source := range writable {
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

	admission, err := telemetrydelivery.Admit(identity, rows, barred, batch, received)
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

// bindSources binds each source to the batch's participant unless it is bound already. It refuses
// the batch unless the participant is the bound one of the batch's own source or a successor of
// it, and returns the predecessors the participant may not write (see telemetrydelivery.Authorize).
// The inserts run in source order, and an insert that meets another transaction's uncommitted
// binding of the same source waits for it, so two first batches of one source from different
// participants leave exactly one binding: the one that commits first. Bindings never change once
// written, so reading them back needs no lock.
func bindSources(ctx context.Context, queries *sqlc.Queries, identity telemetrydelivery.Identity, own utilities.ID, sources []utilities.ID, received time.Time) ([]utilities.ID, error) {
	ids := make([]pgtype.UUID, 0, len(sources))
	for _, source := range sources {
		ids = append(ids, uuid(source))
	}
	identityID, err := queries.TelemetryParticipantIdentity(ctx, sqlc.TelemetryParticipantIdentityParams{TenantID: uuid(identity.TenantID), ID: uuid(identity.ParticipantID)})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("read the telemetry participant's identity: %w", err)
	}
	claimant := telemetrydelivery.Claimant{ParticipantID: identity.ParticipantID, IdentityID: nullableID(identityID)}
	for _, source := range sources {
		err := queries.EnsureTelemetrySourceBinding(ctx, sqlc.EnsureTelemetrySourceBindingParams{
			TenantID: uuid(identity.TenantID), SourceID: uuid(source), ParticipantID: uuid(claimant.ParticipantID), IdentityID: uuid(claimant.IdentityID),
			BoundAt: pgtype.Timestamptz{Time: received, Valid: true},
		})
		if err != nil {
			return nil, fmt.Errorf("bind the telemetry source: %w", err)
		}
	}
	stored, err := queries.ListTelemetrySourceBindings(ctx, sqlc.ListTelemetrySourceBindingsParams{TenantID: uuid(identity.TenantID), SourceIds: ids})
	if err != nil {
		return nil, fmt.Errorf("read the telemetry source bindings: %w", err)
	}
	if len(stored) != len(sources) {
		return nil, fmt.Errorf("read the telemetry source bindings: %d of %d sources bound", len(stored), len(sources))
	}
	bindings := make([]telemetrydelivery.Binding, 0, len(stored))
	for _, item := range stored {
		bindings = append(bindings, telemetrydelivery.Binding{
			TenantID: nullableID(item.TenantID), SourceID: nullableID(item.SourceID), ParticipantID: nullableID(item.ParticipantID),
			IdentityID: nullableID(item.IdentityID), BoundAt: timestamp(item.BoundAt),
		})
	}
	return telemetrydelivery.Authorize(bindings, claimant, own)
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
