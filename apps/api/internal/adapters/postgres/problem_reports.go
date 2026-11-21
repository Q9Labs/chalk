package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/diagnosticuploads"
	"github.com/q9labs/chalk/apps/api/internal/liverequests"
	"github.com/q9labs/chalk/apps/api/internal/problemreports"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/trace"
)

type ProblemReportRepository struct {
	queries problemReportQuerier
	db      problemReportDB
}
type problemReportDB interface {
	sqlc.DBTX
	Begin(context.Context) (pgx.Tx, error)
}
type problemReportQuerier interface {
	GetProblemReportAttribution(context.Context, sqlc.GetProblemReportAttributionParams) (sqlc.GetProblemReportAttributionRow, error)
	SetProblemReportForwardOutcome(context.Context, sqlc.SetProblemReportForwardOutcomeParams) error
	GetProblemReport(context.Context, sqlc.GetProblemReportParams) (sqlc.GetProblemReportRow, error)
}

func NewProblemReportRepository(db problemReportDB) ProblemReportRepository {
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

// StoreReport commits the durable row and the problem_report.delivered ledger
// event in one transaction. Sent means stored; a commit failure is a journey
// error, so the service keeps the existing journey_* causes.
func (r ProblemReportRepository) StoreReport(ctx context.Context, subject accessgrants.Subject, report problemreports.StoredReport) error {
	attributes, err := json.Marshal(struct {
		TenantID  string `json:"tenant_id"`
		SpaceID   string `json:"space_id"`
		EpisodeID string `json:"episode_id"`
		ReportID  string `json:"report_id"`
	}{subject.TenantID.String(), subject.SpaceID.String(), subject.EpisodeID.String(), report.ID.String()})
	if err != nil {
		return err
	}
	span := trace.SpanContextFromContext(ctx)
	var traceID, spanID string
	if span.IsValid() {
		traceID = span.TraceID().String()
		spanID = span.SpanID().String()
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return reportJourneyError(err)
	}
	defer tx.Rollback(ctx)
	// Both purge paths fence the journey table before deleting the Tenant.
	// Take that table lock before the Tenant row lock, keeping the same order.
	if _, err := tx.Exec(ctx, `lock table observability_journey_events in row exclusive mode`); err != nil {
		return reportJourneyError(err)
	}
	queries := sqlc.New(tx)
	if err := queries.InsertProblemReport(ctx, sqlc.InsertProblemReportParams{
		ID:              uuid(report.ID),
		ChkCode:         report.ChkCode,
		TenantID:        uuid(subject.TenantID),
		SpaceID:         uuid(subject.SpaceID),
		EpisodeID:       uuid(subject.EpisodeID),
		ParticipantID:   uuid(subject.ParticipantID),
		Generation:      pgtype.Int8{Int64: subject.ParticipantGeneration, Valid: true},
		ClientSessionID: uuid(report.ClientSessionID),
		SdkVersion:      optionalText(report.SDKVersion),
		JourneyID:       uuid(report.JourneyID),
		PickedSymptom:   report.PickedSymptom,
		Description:     report.Description,
		Diagnostics:     optionalText(report.Diagnostics),
		ForwardOutcome:  "pending",
	}); err != nil {
		return reportJourneyError(err)
	}
	_, err = tx.Exec(ctx, `with live_tenant as materialized (
        select id from tenants where id=$6 for key share
    ) insert into observability_journey_events(event_id,journey_id,sequence,occurred_at,name,phase,state,origin_kind,first_observed_layer,upstream_visibility,trace_id,span_id,attributes)
    select $1,$2,0,now(),'problem_report.delivered','terminal','succeeded','server','api','visible',$3,$4,$5::jsonb from live_tenant
    on conflict(event_id) do nothing`,
		uuid(report.ID), uuid(report.JourneyID), optionalText(traceID), optionalText(spanID), string(attributes), uuid(subject.TenantID))
	if err != nil {
		return reportJourneyError(err)
	}
	return reportJourneyError(tx.Commit(ctx))
}

func (r ProblemReportRepository) SetForwardOutcome(ctx context.Context, tenantID utilities.ID, reportID utilities.ID, outcome string) error {
	return r.queries.SetProblemReportForwardOutcome(ctx, sqlc.SetProblemReportForwardOutcomeParams{
		TenantID:       uuid(tenantID),
		ID:             uuid(reportID),
		ForwardOutcome: outcome,
	})
}

// ReportTarget is the identity an upload's object key needs from the stored row.
func (r ProblemReportRepository) ReportTarget(ctx context.Context, tenantID utilities.ID, reportID utilities.ID) (diagnosticuploads.ReportTarget, error) {
	row, err := r.queries.GetProblemReport(ctx, sqlc.GetProblemReportParams{TenantID: uuid(tenantID), ID: uuid(reportID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return diagnosticuploads.ReportTarget{}, diagnosticuploads.ErrTargetMissing
	}
	if err != nil {
		return diagnosticuploads.ReportTarget{}, err
	}
	return diagnosticuploads.ReportTarget{ID: id(row.ID), EpisodeID: nullableID(row.EpisodeID), ParticipantID: nullableID(row.ParticipantID)}, nil
}

// DiagnosticUploadRepository stores issued upload rows and their state changes.
type DiagnosticUploadRepository struct {
	db problemReportDB
}

func NewDiagnosticUploadRepository(db problemReportDB) DiagnosticUploadRepository {
	return DiagnosticUploadRepository{db: db}
}

// ReportTarget reads the report row an upload's object key is built on; the
// same lookup lives on ProblemReportRepository for the send path.
func (r DiagnosticUploadRepository) ReportTarget(ctx context.Context, tenantID utilities.ID, reportID utilities.ID) (diagnosticuploads.ReportTarget, error) {
	row, err := sqlc.New(r.db).GetProblemReport(ctx, sqlc.GetProblemReportParams{TenantID: uuid(tenantID), ID: uuid(reportID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return diagnosticuploads.ReportTarget{}, diagnosticuploads.ErrTargetMissing
	}
	if err != nil {
		return diagnosticuploads.ReportTarget{}, err
	}
	return diagnosticuploads.ReportTarget{ID: id(row.ID), EpisodeID: nullableID(row.EpisodeID), ParticipantID: nullableID(row.ParticipantID)}, nil
}

func (r DiagnosticUploadRepository) LiveTarget(ctx context.Context, tenantID utilities.ID, requestID utilities.ID) (diagnosticuploads.LiveTarget, error) {
	row, err := sqlc.New(r.db).GetLiveIntrospectionRequest(ctx, sqlc.GetLiveIntrospectionRequestParams{TenantID: uuid(tenantID), ID: uuid(requestID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return diagnosticuploads.LiveTarget{}, diagnosticuploads.ErrTargetMissing
	}
	if err != nil {
		return diagnosticuploads.LiveTarget{}, err
	}
	return diagnosticuploads.LiveTarget{
		ID:            id(row.ID),
		EpisodeID:     id(row.EpisodeID),
		ParticipantID: nullableID(row.ParticipantID),
		ExpiresAt:     row.ExpiresAt.Time,
	}, nil
}

func (r DiagnosticUploadRepository) InsertIssued(ctx context.Context, upload diagnosticuploads.Upload) (diagnosticuploads.Upload, error) {
	row, err := sqlc.New(r.db).InsertDiagnosticUpload(ctx, sqlc.InsertDiagnosticUploadParams{
		ID:            uuid(upload.ID),
		TenantID:      uuid(upload.TenantID),
		EpisodeID:     uuid(upload.EpisodeID),
		ReportID:      uuid(upload.ReportID),
		LiveRequestID: uuid(upload.LiveRequestID),
		Trigger:       upload.Trigger,
		ObjectKey:     upload.ObjectKey,
		ExpiresAt:     pgtype.Timestamptz{Time: upload.ExpiresAt, Valid: true},
	})
	if err != nil {
		var pgError *pgconn.PgError
		if errors.As(err, &pgError) && pgError.Code == "23505" {
			return diagnosticuploads.Upload{}, diagnosticuploads.ErrUploadExists
		}
		return diagnosticuploads.Upload{}, err
	}
	upload.ExpiresAt = row.ExpiresAt.Time
	return upload, nil
}

func (r DiagnosticUploadRepository) Get(ctx context.Context, tenantID utilities.ID, uploadID utilities.ID) (diagnosticuploads.Upload, error) {
	row, err := sqlc.New(r.db).GetDiagnosticUpload(ctx, sqlc.GetDiagnosticUploadParams{TenantID: uuid(tenantID), ID: uuid(uploadID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return diagnosticuploads.Upload{}, diagnosticuploads.ErrUploadMissing
	}
	if err != nil {
		return diagnosticuploads.Upload{}, err
	}
	upload := diagnosticuploads.Upload{
		ID:            id(row.ID),
		TenantID:      id(row.TenantID),
		EpisodeID:     nullableID(row.EpisodeID),
		ReportID:      nullableID(row.ReportID),
		LiveRequestID: nullableID(row.LiveRequestID),
		Trigger:       row.Trigger,
		State:         row.State,
		ObjectKey:     row.ObjectKey,
		IssuedAt:      row.IssuedAt.Time,
		ExpiresAt:     row.ExpiresAt.Time,
	}
	if row.Bytes.Valid {
		upload.Bytes = &row.Bytes.Int64
	}
	if row.Sha256.Valid {
		upload.SHA256 = row.Sha256.String
	}
	if row.StoredAt.Valid {
		upload.StoredAt = &row.StoredAt.Time
	}
	if row.FailedAt.Valid {
		upload.FailedAt = &row.FailedAt.Time
	}
	return upload, nil
}

func (r DiagnosticUploadRepository) MarkStored(ctx context.Context, tenantID utilities.ID, uploadID utilities.ID, bytes int64, sha256 string) error {
	return sqlc.New(r.db).CompleteDiagnosticUpload(ctx, sqlc.CompleteDiagnosticUploadParams{
		TenantID: uuid(tenantID),
		ID:       uuid(uploadID),
		Bytes:    pgtype.Int8{Int64: bytes, Valid: true},
		Sha256:   optionalText(sha256),
	})
}

func (r DiagnosticUploadRepository) MarkFailed(ctx context.Context, tenantID utilities.ID, uploadID utilities.ID) error {
	return sqlc.New(r.db).FailDiagnosticUpload(ctx, sqlc.FailDiagnosticUploadParams{TenantID: uuid(tenantID), ID: uuid(uploadID)})
}

func (r DiagnosticUploadRepository) MarkExpired(ctx context.Context, tenantID utilities.ID, uploadID utilities.ID) error {
	return sqlc.New(r.db).ExpireDiagnosticUpload(ctx, sqlc.ExpireDiagnosticUploadParams{TenantID: uuid(tenantID), ID: uuid(uploadID)})
}

// LiveIntrospectionRepository creates requests under the Episode row lock so a
// pending check and the hourly cap cannot race a concurrent create.
type LiveIntrospectionRepository struct {
	db problemReportDB
}

func NewLiveIntrospectionRepository(db problemReportDB) LiveIntrospectionRepository {
	return LiveIntrospectionRepository{db: db}
}

func (r LiveIntrospectionRepository) Create(ctx context.Context, input liverequests.Input) (liverequests.Request, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return liverequests.Request{}, err
	}
	defer tx.Rollback(ctx)
	queries := sqlc.New(tx)
	if _, err := queries.LockLiveRequestEpisode(ctx, sqlc.LockLiveRequestEpisodeParams{TenantID: uuid(input.TenantID), EpisodeID: uuid(input.EpisodeID)}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return liverequests.Request{}, liverequests.ErrEpisodeMissing
		}
		return liverequests.Request{}, err
	}
	pending, err := queries.CountPendingLiveIntrospectionRequests(ctx, sqlc.CountPendingLiveIntrospectionRequestsParams{
		TenantID:      uuid(input.TenantID),
		EpisodeID:     uuid(input.EpisodeID),
		ParticipantID: uuid(input.ParticipantID),
	})
	if err != nil {
		return liverequests.Request{}, err
	}
	if pending > 0 {
		return liverequests.Request{}, liverequests.ErrPending
	}
	hourly, err := queries.CountEpisodeLiveIntrospectionRequests(ctx, sqlc.CountEpisodeLiveIntrospectionRequestsParams{TenantID: uuid(input.TenantID), EpisodeID: uuid(input.EpisodeID)})
	if err != nil {
		return liverequests.Request{}, err
	}
	if hourly >= liverequests.HourlyLimit {
		return liverequests.Request{}, liverequests.ErrRateLimited
	}
	row, err := queries.InsertLiveIntrospectionRequest(ctx, sqlc.InsertLiveIntrospectionRequestParams{
		ID:            uuid(input.ID),
		TenantID:      uuid(input.TenantID),
		EpisodeID:     uuid(input.EpisodeID),
		ParticipantID: uuid(input.ParticipantID),
	})
	if err != nil {
		return liverequests.Request{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return liverequests.Request{}, err
	}
	return liverequests.Request{
		ID:                id(row.ID),
		ParticipantID:     nullableID(row.ParticipantID),
		RequestedAt:       row.RequestedAt.Time,
		ExpiresAt:         row.ExpiresAt.Time,
		ParticipantStatus: row.ParticipantStatus.String,
		EpisodeStatus:     row.EpisodeStatus.String,
	}, nil
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
