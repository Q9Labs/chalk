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
	"github.com/q9labs/chalk/apps/api/internal/status"
)

var statusTracer = otel.Tracer("github.com/q9labs/chalk/apps/api/internal/adapters/postgres/status")

type StatusRepository struct {
	pool *pgxpool.Pool
}

func NewStatusRepository(pool *pgxpool.Pool) StatusRepository {
	return StatusRepository{pool: pool}
}

func (r StatusRepository) Append(ctx context.Context, input status.MonitorResult) (inserted bool, err error) {
	if r.pool == nil {
		return false, status.ErrStatusUnavailable
	}
	ctx, span := statusTracer.Start(ctx, "db.status_monitor_results.append", trace.WithSpanKind(trace.SpanKindClient))
	defer span.End()
	defer func() {
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "status result write failed")
			return
		}
		span.SetAttributes(attribute.Bool("status.inserted", inserted))
	}()

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return false, statusStoreFailure("begin transaction", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	queries := sqlc.New(tx)
	row, err := queries.InsertStatusMonitorResult(ctx, statusResultParams(input))
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, statusStoreFailure("insert monitor result", err)
	}
	if _, err := queries.UpsertStatusMonitorCurrent(ctx, currentParams(input)); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, statusStoreFailure("project current monitor result", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, statusStoreFailure("commit status result", err)
	}
	_ = row
	return true, nil
}

func (r StatusRepository) Current(ctx context.Context) (rows []status.CurrentResult, err error) {
	if r.pool == nil {
		return nil, status.ErrStatusUnavailable
	}
	ctx, span := statusTracer.Start(ctx, "db.status_monitor_current.list", trace.WithSpanKind(trace.SpanKindClient))
	defer span.End()
	defer func() {
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "status projection read failed")
		}
	}()
	items, err := sqlc.New(r.pool).ListStatusMonitorCurrent(ctx)
	if err != nil {
		return nil, statusStoreFailure("list current monitor results", err)
	}
	rows = make([]status.CurrentResult, 0, len(items))
	for _, item := range items {
		rows = append(rows, status.CurrentResult{
			MonitorKey:    item.MonitorKey,
			ResultKey:     item.ResultKey,
			RunID:         item.RunID,
			Status:        item.Status,
			CheckedAt:     timestamp(item.CheckedAt),
			LastChangedAt: timestamp(item.LastChangedAt),
			ReceivedAt:    timestamp(item.ReceivedAt),
		})
	}
	return rows, nil
}

func statusResultParams(input status.MonitorResult) sqlc.InsertStatusMonitorResultParams {
	return sqlc.InsertStatusMonitorResultParams{
		ResultKey:         input.ResultKey,
		RunID:             input.RunID,
		MonitorKey:        input.MonitorKey,
		Status:            input.Status,
		CheckedAt:         pgtype.Timestamptz{Time: input.CheckedAt, Valid: true},
		EventAt:           pgtype.Timestamptz{Time: input.EventAt, Valid: true},
		LatencyMs:         input.LatencyMS,
		HttpStatus:        optionalInt4(input.HTTPStatus),
		ErrorCode:         text(stringPointer(input.ErrorCode)),
		ErrorMessage:      text(stringPointer(input.ErrorMessage)),
		ResponseExcerpt:   text(stringPointer(input.ResponseExcerpt)),
		ReportedSource:    input.ReportedSource,
		ReportedEmitterID: input.ReportedEmitterID,
		Metadata:          jsonObject(input.Metadata),
		Details:           jsonObject(input.Details),
		ReceivedAt:        pgtype.Timestamptz{Time: input.ReceivedAt, Valid: true},
	}
}

func currentParams(input status.MonitorResult) sqlc.UpsertStatusMonitorCurrentParams {
	return sqlc.UpsertStatusMonitorCurrentParams{
		MonitorKey: input.MonitorKey,
		ResultKey:  input.ResultKey,
		RunID:      input.RunID,
		Status:     input.Status,
		CheckedAt:  pgtype.Timestamptz{Time: input.CheckedAt, Valid: true},
		ReceivedAt: pgtype.Timestamptz{Time: input.ReceivedAt, Valid: true},
	}
}

func statusStoreFailure(operation string, err error) error {
	return fmt.Errorf("%w: %s: %w", status.ErrStatusUnavailable, operation, err)
}

func optionalInt4(value *int) pgtype.Int4 {
	if value == nil {
		return pgtype.Int4{}
	}
	return pgtype.Int4{Int32: int32(*value), Valid: true}
}

func stringPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func jsonObject(value []byte) []byte {
	if len(value) == 0 {
		return []byte(`{}`)
	}
	return value
}

var _ status.Repository = StatusRepository{}
