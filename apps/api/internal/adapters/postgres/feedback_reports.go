package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/feedback"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type FeedbackRepository struct {
	queries sqlc.Querier
}

func NewFeedbackRepository(queries sqlc.Querier) FeedbackRepository {
	return FeedbackRepository{queries: queries}
}

func (r FeedbackRepository) GetByIdempotency(ctx context.Context, lookup feedback.IdempotencyLookup) (feedback.Report, error) {
	if r.queries == nil {
		return feedback.Report{}, feedback.ErrRepositoryUnavailable
	}
	row, err := r.queries.GetFeedbackReportByIdempotency(ctx, sqlc.GetFeedbackReportByIdempotencyParams{TenantID: uuid(lookup.TenantID), SubmitterKind: string(lookup.SubmitterKind), SubmitterID: lookup.SubmitterID, IdempotencyKey: lookup.Key})
	if errors.Is(err, pgx.ErrNoRows) {
		return feedback.Report{}, feedback.ErrReportNotFound
	}
	if err != nil {
		return feedback.Report{}, fmt.Errorf("get feedback idempotency record: %w", err)
	}
	return mapFeedbackReport(row), nil
}

func (r FeedbackRepository) Create(ctx context.Context, input feedback.CreateInput) (feedback.Report, error) {
	if r.queries == nil {
		return feedback.Report{}, feedback.ErrRepositoryUnavailable
	}
	params := insertFeedbackReportParams(input.Report)
	row, err := r.queries.InsertFeedbackReport(ctx, params)
	if err != nil {
		return feedback.Report{}, fmt.Errorf("insert feedback report: %w", err)
	}
	return mapFeedbackReport(row), nil
}

func (r FeedbackRepository) Get(ctx context.Context, id utilities.ID) (feedback.Report, error) {
	if r.queries == nil {
		return feedback.Report{}, feedback.ErrRepositoryUnavailable
	}
	row, err := r.queries.GetFeedbackReportForOperator(ctx, uuid(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return feedback.Report{}, feedback.ErrReportNotFound
	}
	if err != nil {
		return feedback.Report{}, fmt.Errorf("get feedback report: %w", err)
	}
	return mapFeedbackReport(row), nil
}

func (r FeedbackRepository) GetForTenant(ctx context.Context, tenantID, id utilities.ID) (feedback.Report, error) {
	if r.queries == nil {
		return feedback.Report{}, feedback.ErrRepositoryUnavailable
	}
	row, err := r.queries.GetFeedbackReport(ctx, sqlc.GetFeedbackReportParams{TenantID: uuid(tenantID), ID: uuid(id)})
	if errors.Is(err, pgx.ErrNoRows) {
		return feedback.Report{}, feedback.ErrReportNotFound
	}
	if err != nil {
		return feedback.Report{}, fmt.Errorf("get tenant feedback report: %w", err)
	}
	return mapFeedbackReport(row), nil
}

func (r FeedbackRepository) List(ctx context.Context, input feedback.ListInput) (feedback.ListResult, error) {
	if r.queries == nil {
		return feedback.ListResult{}, feedback.ErrRepositoryUnavailable
	}
	params := sqlc.ListFeedbackReportsParams{PageLimit: int32(input.Limit + 1)}
	if input.Category != "" {
		params.Category = pgtype.Text{String: string(input.Category), Valid: true}
	}
	if input.Source != "" {
		params.Source = pgtype.Text{String: string(input.Source), Valid: true}
	}
	if input.TenantID != nil {
		params.TenantID = uuid(*input.TenantID)
	}
	if input.From != nil {
		params.FromTime = timestamptz(input.From)
	}
	if input.To != nil {
		params.ToTime = timestamptz(input.To)
	}
	if input.Cursor != nil {
		params.CursorCreatedAt = pgtype.Timestamptz{Time: input.Cursor.CreatedAt.UTC(), Valid: true}
		params.CursorID = uuid(input.Cursor.ID)
	}
	rows, err := r.queries.ListFeedbackReports(ctx, params)
	if err != nil {
		return feedback.ListResult{}, fmt.Errorf("list feedback reports: %w", err)
	}
	result := feedback.ListResult{Reports: make([]feedback.Report, 0, len(rows))}
	if len(rows) > input.Limit {
		result.HasMore = true
		rows = rows[:input.Limit]
	}
	for _, row := range rows {
		result.Reports = append(result.Reports, mapFeedbackReport(row))
	}
	if result.HasMore && len(result.Reports) > 0 {
		last := result.Reports[len(result.Reports)-1]
		result.NextCursor = &pagination.Cursor{CreatedAt: last.CreatedAt, ID: last.ID}
	}
	return result, nil
}

func insertFeedbackReportParams(report feedback.Report) sqlc.InsertFeedbackReportParams {
	return sqlc.InsertFeedbackReportParams{
		ID: uuid(report.ID), TenantID: uuid(report.TenantID), Category: string(report.Category), Source: string(report.Source), Message: report.Message,
		SubmitterKind: string(report.SubmitterKind), SubmitterID: report.SubmitterID, UserID: feedbackOptionalUUID(report.UserID), SpaceID: feedbackOptionalUUID(report.SpaceID), EpisodeID: feedbackOptionalUUID(report.EpisodeID), ParticipantID: feedbackOptionalUUID(report.ParticipantID),
		Environment: text(feedbackStringPtr(report.Environment)), Audience: text(feedbackStringPtr(report.Audience)), DiagnosticReference: text(feedbackStringPtr(report.DiagnosticReference)), JourneyID: feedbackOptionalUUID(report.JourneyID), RootJourneyID: feedbackOptionalUUID(report.RootJourneyID),
		TraceID: text(feedbackStringPtr(report.TraceID)), SpanID: text(feedbackStringPtr(report.SpanID)), RequestID: text(feedbackStringPtr(report.RequestID)), CommandID: text(feedbackStringPtr(report.CommandID)), SubmissionJourneyID: feedbackOptionalUUID(report.SubmissionJourneyID), SubmissionTraceID: text(feedbackStringPtr(report.SubmissionTraceID)), SubmissionSpanID: text(feedbackStringPtr(report.SubmissionSpanID)),
		IdempotencyKey: report.IdempotencyKey, RequestDigest: report.RequestDigest[:], EvidenceObjectKey: report.EvidenceObjectKey, EvidenceContentType: "application/json", EvidenceSize: report.EvidenceSize, EvidenceSha256: report.EvidenceSHA256[:], EvidenceSchemaVersion: report.EvidenceSchemaVersion, ScreenshotFailureCode: text(feedbackStringPtr(report.ScreenshotFailureCode)),
		ScreenshotObjectKey: screenshotText(report.Screenshot, func(value *feedback.ScreenshotMetadata) string { return value.ObjectKey }), ScreenshotContentType: screenshotText(report.Screenshot, func(value *feedback.ScreenshotMetadata) string { return value.ContentType }), ScreenshotSize: screenshotInt8(report.Screenshot, func(value *feedback.ScreenshotMetadata) int64 { return value.Size }), ScreenshotSha256: screenshotDigest(report.Screenshot), ScreenshotWidth: screenshotInt4(report.Screenshot, func(value *feedback.ScreenshotMetadata) int { return value.Width }), ScreenshotHeight: screenshotInt4(report.Screenshot, func(value *feedback.ScreenshotMetadata) int { return value.Height }), ScreenshotCapturedAt: screenshotTime(report.Screenshot), CreatedAt: pgtype.Timestamptz{Time: report.CreatedAt.UTC(), Valid: true}, SubmittedAt: pgtype.Timestamptz{Time: report.SubmittedAt.UTC(), Valid: true},
	}
}

func mapFeedbackReport(row sqlc.FeedbackReport) feedback.Report {
	report := feedback.Report{ID: nullableID(row.ID), TenantID: nullableID(row.TenantID), Category: feedback.Category(row.Category), Source: feedback.Source(row.Source), Message: row.Message, SubmitterKind: feedback.SubmitterKind(row.SubmitterKind), SubmitterID: row.SubmitterID, Environment: feedbackNullableTextValue(row.Environment), Audience: feedbackNullableTextValue(row.Audience), DiagnosticReference: feedbackNullableTextValue(row.DiagnosticReference), TraceID: feedbackNullableTextValue(row.TraceID), SpanID: feedbackNullableTextValue(row.SpanID), RequestID: feedbackNullableTextValue(row.RequestID), CommandID: feedbackNullableTextValue(row.CommandID), SubmissionTraceID: feedbackNullableTextValue(row.SubmissionTraceID), SubmissionSpanID: feedbackNullableTextValue(row.SubmissionSpanID), IdempotencyKey: row.IdempotencyKey, EvidenceObjectKey: row.EvidenceObjectKey, EvidenceSize: row.EvidenceSize, EvidenceSchemaVersion: row.EvidenceSchemaVersion, ScreenshotFailureCode: feedbackNullableTextValue(row.ScreenshotFailureCode), CreatedAt: timestamp(row.CreatedAt), SubmittedAt: timestamp(row.SubmittedAt)}
	copy(report.RequestDigest[:], row.RequestDigest)
	copy(report.EvidenceSHA256[:], row.EvidenceSha256)
	setOptionalUUID(&report.UserID, row.UserID)
	setOptionalUUID(&report.SpaceID, row.SpaceID)
	setOptionalUUID(&report.EpisodeID, row.EpisodeID)
	setOptionalUUID(&report.ParticipantID, row.ParticipantID)
	setOptionalUUID(&report.JourneyID, row.JourneyID)
	setOptionalUUID(&report.RootJourneyID, row.RootJourneyID)
	setOptionalUUID(&report.SubmissionJourneyID, row.SubmissionJourneyID)
	if row.ScreenshotObjectKey.Valid {
		metadata := &feedback.ScreenshotMetadata{ObjectKey: row.ScreenshotObjectKey.String, ContentType: feedbackNullableTextValue(row.ScreenshotContentType), Size: row.ScreenshotSize.Int64, CapturedAt: timestamp(row.ScreenshotCapturedAt)}
		copy(metadata.SHA256[:], row.ScreenshotSha256)
		if row.ScreenshotWidth.Valid {
			metadata.Width = int(row.ScreenshotWidth.Int32)
		}
		if row.ScreenshotHeight.Valid {
			metadata.Height = int(row.ScreenshotHeight.Int32)
		}
		report.Screenshot = metadata
	}
	return report
}

func feedbackOptionalUUID(value *utilities.ID) pgtype.UUID {
	if value == nil {
		return pgtype.UUID{}
	}
	return uuid(*value)
}

func setOptionalUUID(target **utilities.ID, value pgtype.UUID) {
	if !value.Valid {
		return
	}
	id := nullableID(value)
	*target = &id
}

func feedbackNullableTextValue(value pgtype.Text) string {
	if !value.Valid {
		return ""
	}
	return value.String
}

func feedbackStringPtr(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func screenshotText(value *feedback.ScreenshotMetadata, get func(*feedback.ScreenshotMetadata) string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	return text(feedbackStringPtr(get(value)))
}

func screenshotInt8(value *feedback.ScreenshotMetadata, get func(*feedback.ScreenshotMetadata) int64) pgtype.Int8 {
	if value == nil {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: get(value), Valid: true}
}

func screenshotInt4(value *feedback.ScreenshotMetadata, get func(*feedback.ScreenshotMetadata) int) pgtype.Int4 {
	if value == nil {
		return pgtype.Int4{}
	}
	return pgtype.Int4{Int32: int32(get(value)), Valid: true}
}

func screenshotDigest(value *feedback.ScreenshotMetadata) []byte {
	if value == nil {
		return nil
	}
	return value.SHA256[:]
}

func screenshotTime(value *feedback.ScreenshotMetadata) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: value.CapturedAt.UTC(), Valid: true}
}

var _ feedback.Repository = FeedbackRepository{}
