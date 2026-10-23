package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/problemreports"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/trace"
	"net"
	"strings"
)

type ProblemReportRepository struct {
	queries problemReportQuerier
	db      sqlc.DBTX
}
type problemReportQuerier interface {
	GetProblemReportAttribution(context.Context, sqlc.GetProblemReportAttributionParams) (sqlc.GetProblemReportAttributionRow, error)
}

func NewProblemReportRepository(db sqlc.DBTX) ProblemReportRepository {
	return ProblemReportRepository{queries: sqlc.New(db), db: db}
}
func (r ProblemReportRepository) Attribution(ctx context.Context, subject accessgrants.Subject) (problemreports.Attribution, error) {
	row, err := r.queries.GetProblemReportAttribution(ctx, sqlc.GetProblemReportAttributionParams{TenantID: uuid(subject.TenantID), SpaceID: uuid(subject.SpaceID), EpisodeID: uuid(subject.EpisodeID), ParticipantID: uuid(subject.ParticipantID), ParticipantGeneration: subject.ParticipantGeneration})
	if errors.Is(err, pgx.ErrNoRows) {
		return problemreports.Attribution{}, problemreports.ErrForbidden
	}
	if err != nil {
		return problemreports.Attribution{}, fmt.Errorf("get report attribution: %w", err)
	}
	return problemreports.Attribution{SpaceName: row.SpaceName, ReporterName: row.ReporterName, Role: row.ReporterRole}, nil
}

func (r ProblemReportRepository) RecordDelivery(ctx context.Context, subject accessgrants.Subject, reportID utilities.ID) error {
	attributes, err := json.Marshal(struct {
		TenantID  string `json:"tenant_id"`
		SpaceID   string `json:"space_id"`
		EpisodeID string `json:"episode_id"`
		ReportID  string `json:"report_id"`
	}{subject.TenantID.String(), subject.SpaceID.String(), subject.EpisodeID.String(), reportID.String()})
	if err != nil {
		return err
	}
	span := trace.SpanContextFromContext(ctx)
	var traceID, spanID string
	if span.IsValid() {
		traceID = span.TraceID().String()
		spanID = span.SpanID().String()
	}
	// The report owns its journey; caller-supplied journey IDs cannot block a Tenant purge.
	// A row lock makes Tenant existence and the write atomic with both purge paths.
	_, err = r.db.Exec(ctx, `with live_tenant as materialized (
        select id from tenants where id=$5 for key share
    ) insert into observability_journey_events(event_id,journey_id,sequence,occurred_at,name,phase,state,origin_kind,first_observed_layer,upstream_visibility,trace_id,span_id,attributes)
    select $1,$1,0,now(),'problem_report.delivered','terminal','succeeded','server','api','visible',$2,$3,$4 from live_tenant
    on conflict(event_id) do nothing`, uuid(reportID), optionalText(traceID), optionalText(spanID), attributes, uuid(subject.TenantID))
	return reportJourneyError(err)
}

func reportJourneyError(err error) error {
	if err == nil {
		return nil
	}
	var pgError *pgconn.PgError
	var network net.Error
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return context.DeadlineExceeded
	case errors.Is(err, context.Canceled):
		return context.Canceled
	case errors.As(err, &pgError):
		switch {
		case pgError.Code == "42501" || strings.HasPrefix(pgError.Code, "28"):
			return problemreports.ErrJourneyPermission
		case strings.HasPrefix(pgError.Code, "22") || strings.HasPrefix(pgError.Code, "23"):
			return problemreports.ErrJourneyConstraint
		case strings.HasPrefix(pgError.Code, "08"):
			return problemreports.ErrJourneyUnavailable
		}
	case errors.As(err, &network):
		if network.Timeout() {
			return context.DeadlineExceeded
		}
		return problemreports.ErrJourneyUnavailable
	}
	return err
}
