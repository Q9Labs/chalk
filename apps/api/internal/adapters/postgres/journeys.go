package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/journeys"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var journeyTracer = otel.Tracer("github.com/q9labs/chalk/apps/api/internal/adapters/postgres/journeys")

type JourneyRepository struct {
	pool *pgxpool.Pool
}

func NewJourneyRepository(pool *pgxpool.Pool) JourneyRepository {
	return JourneyRepository{pool: pool}
}

func (r JourneyRepository) Append(ctx context.Context, events []journeys.Event) (accepted int, duplicate int, err error) {
	if r.pool == nil {
		return 0, 0, journeys.ErrJourneyLedgerUnavailable
	}

	ctx, span := journeyTracer.Start(ctx, "db.observability_journey_events.append", trace.WithSpanKind(trace.SpanKindClient))
	defer span.End()
	span.SetAttributes(attribute.Int("journey.events.count", len(events)))

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "begin journey ledger transaction")
		return 0, 0, journeyLedgerFailure("begin transaction", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	queries := sqlc.New(tx)
	for _, event := range events {
		_, err := queries.InsertJourneyEvent(ctx, insertJourneyEventParams(event))
		if errors.Is(err, pgx.ErrNoRows) {
			duplicate++
			continue
		}
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "append journey event")
			return 0, 0, journeyLedgerFailure("append event", err)
		}
		accepted++
	}

	if err := tx.Commit(ctx); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "commit journey ledger transaction")
		return 0, 0, journeyLedgerFailure("commit transaction", err)
	}
	span.SetAttributes(
		attribute.Int("journey.events.accepted", accepted),
		attribute.Int("journey.events.duplicates", duplicate),
	)
	return accepted, duplicate, nil
}

func (r JourneyRepository) Get(ctx context.Context, journeyID utilities.ID) (ledger journeys.Ledger, err error) {
	if r.pool == nil {
		return journeys.Ledger{}, journeys.ErrJourneyLedgerUnavailable
	}

	ctx, span := journeyTracer.Start(ctx, "db.observability_journey_events.get", trace.WithSpanKind(trace.SpanKindClient))
	defer span.End()
	queries := sqlc.New(r.pool)
	rows, err := queries.ListJourneyEvents(ctx, uuid(journeyID))
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "list journey events")
		return journeys.Ledger{}, journeyLedgerFailure("list journey events", err)
	}
	if len(rows) == 0 {
		return journeys.Ledger{}, journeys.ErrJourneyNotFound
	}

	ledger = journeys.Ledger{
		JourneyID: journeyID,
		Events:    make([]journeys.Event, 0, len(rows)),
	}
	for _, row := range rows {
		ledger.Events = append(ledger.Events, mapJourneyEvent(row))
	}
	state, err := queries.GetJourneyTerminalState(ctx, uuid(journeyID))
	if err == nil {
		ledger.TerminalState = &state
	} else if !errors.Is(err, pgx.ErrNoRows) {
		span.RecordError(err)
		span.SetStatus(codes.Error, "get journey terminal state")
		return journeys.Ledger{}, journeyLedgerFailure("get journey terminal state", err)
	}
	return ledger, nil
}

func journeyLedgerFailure(operation string, err error) error {
	return fmt.Errorf("%w: %s: %w", journeys.ErrJourneyLedgerUnavailable, operation, err)
}

func insertJourneyEventParams(event journeys.Event) sqlc.InsertJourneyEventParams {
	return sqlc.InsertJourneyEventParams{
		EventID:            uuid(event.EventID),
		JourneyID:          uuid(event.JourneyID),
		Sequence:           event.Sequence,
		OccurredAt:         pgtype.Timestamptz{Time: event.OccurredAt, Valid: true},
		Name:               event.Name,
		Phase:              event.Phase,
		State:              event.State,
		OriginKind:         event.OriginKind,
		FirstObservedLayer: event.FirstObservedLayer,
		UpstreamVisibility: event.UpstreamVisibility,
		ParentEventID:      uuid(event.ParentEventID),
		TraceID:            text(event.TraceID),
		SpanID:             text(event.SpanID),
		Attributes:         jsonBytes(event.Attributes),
	}
}

func mapJourneyEvent(row sqlc.ObservabilityJourneyEvent) journeys.Event {
	return journeys.Event{
		EventID:            utilities.IDFromBytes(row.EventID.Bytes),
		JourneyID:          utilities.IDFromBytes(row.JourneyID.Bytes),
		Sequence:           row.Sequence,
		OccurredAt:         timestamp(row.OccurredAt),
		ReceivedAt:         timestamp(row.ReceivedAt),
		Name:               row.Name,
		Phase:              row.Phase,
		State:              row.State,
		OriginKind:         row.OriginKind,
		FirstObservedLayer: row.FirstObservedLayer,
		UpstreamVisibility: row.UpstreamVisibility,
		ParentEventID:      nullableID(row.ParentEventID),
		TraceID:            nullableText(row.TraceID),
		SpanID:             nullableText(row.SpanID),
		Attributes:         jsonRaw(row.Attributes),
	}
}

var _ journeys.Repository = JourneyRepository{}
