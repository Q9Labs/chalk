package feedback

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var feedbackTracer = otel.Tracer("github.com/q9labs/chalk/apps/api/internal/feedback")

type Service struct {
	repository Repository
	objects    ObjectStore
	telemetry  Telemetry
	now        func() time.Time
}

func NewService(repository Repository, objects ObjectStore) Service {
	return Service{repository: repository, objects: objects, now: time.Now}
}

func (s Service) WithTelemetry(telemetry Telemetry) Service {
	s.telemetry = telemetry
	return s
}

func (s Service) WithClock(now func() time.Time) Service {
	if now == nil {
		now = time.Now
	}
	s.now = now
	return s
}

func (s Service) Submit(ctx context.Context, input SubmitInput) (receipt Receipt, resultErr error) {
	startedAt := time.Now()
	incomingSpan := trace.SpanContextFromContext(ctx)
	ctx, span := feedbackTracer.Start(ctx, "feedback.submit")
	defer func() {
		outcome, reason := feedbackOutcome(resultErr)
		if resultErr != nil {
			span.SetStatus(codes.Error, reason)
		}
		if s.telemetry != nil {
			s.telemetry.RecordFeedback(ctx, "submit", outcome, reason, time.Since(startedAt))
		}
		span.End()
	}()

	if err := validateContext(input.Context, input.IdempotencyKey, input.Request.Source); err != nil {
		span.SetStatus(codes.Error, "invalid context")
		return Receipt{}, err
	}
	request, evidenceJSON, digest, err := input.Request.validate()
	if err != nil {
		span.SetStatus(codes.Error, "invalid request")
		return Receipt{}, err
	}
	span.SetAttributes(attribute.String("feedback.category", string(request.Category)), attribute.String("feedback.source", string(request.Source)), attribute.String("feedback.submitter_kind", string(input.Context.SubmitterKind)))
	if err := bindContext(input.Context, request); err != nil {
		span.SetStatus(codes.Error, "subject binding failed")
		return Receipt{}, err
	}

	if s.repository == nil {
		return Receipt{}, ErrRepositoryUnavailable
	}
	lookup := IdempotencyLookup{TenantID: input.Context.TenantID, SubmitterKind: input.Context.SubmitterKind, SubmitterID: input.Context.SubmitterID, Key: input.IdempotencyKey}
	existing, lookupErr := s.repository.GetByIdempotency(ctx, lookup)
	if lookupErr == nil {
		if existing.RequestDigest != digest {
			return Receipt{}, ErrIdempotencyConflict
		}
		return existing.Receipt(), nil
	}
	if !errors.Is(lookupErr, ErrReportNotFound) {
		return Receipt{}, lookupErr
	}

	reportID, err := utilities.NewID()
	if err != nil {
		return Receipt{}, fmt.Errorf("create feedback id: %w", err)
	}
	now := time.Now()
	if s.now != nil {
		now = s.now()
	}
	now = now.UTC()
	evidenceKey := fmt.Sprintf("feedback/%s/%s/evidence-v1.json", input.Context.TenantID.String(), reportID.String())
	if s.objects == nil {
		return Receipt{}, ErrStorageUnavailable
	}
	evidenceObject, err := s.objects.Put(ctx, evidenceKey, "application/json", evidenceJSON)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "evidence upload failed")
		return Receipt{}, ErrStorageUnavailable
	}
	evidenceObject = objectMetadata(evidenceObject, "application/json")
	evidenceDigest := sha256.Sum256(evidenceJSON)
	if evidenceObject.Size != int64(len(evidenceJSON)) || evidenceObject.SHA256 != evidenceDigest {
		if deleteErr := s.objects.Delete(context.WithoutCancel(ctx), evidenceKey); deleteErr != nil {
			span.RecordError(fmt.Errorf("clean up invalid feedback evidence: %w", deleteErr))
		}
		span.SetStatus(codes.Error, "evidence integrity check failed")
		return Receipt{}, ErrStorageUnavailable
	}
	cleanup := []string{evidenceKey}
	cleanupObjects := func() {
		for _, key := range cleanup {
			if deleteErr := s.objects.Delete(context.WithoutCancel(ctx), key); deleteErr != nil {
				span.RecordError(fmt.Errorf("clean up feedback object: %w", deleteErr))
			}
		}
	}

	var screenshotMetadataValue *ScreenshotMetadata
	if request.Screenshot != nil {
		data, decodeErr := screenshotData(request.Screenshot)
		if decodeErr != nil {
			cleanupObjects()
			return Receipt{}, decodeErr
		}
		extension := strings.TrimPrefix(request.Screenshot.MimeType, "image/")
		if extension == "jpeg" {
			extension = "jpg"
		}
		screenshotKey := fmt.Sprintf("feedback/%s/%s/screenshot.%s", input.Context.TenantID.String(), reportID.String(), extension)
		screenshotObject, putErr := s.objects.Put(ctx, screenshotKey, request.Screenshot.MimeType, data)
		if putErr != nil {
			cleanupObjects()
			span.RecordError(putErr)
			span.SetStatus(codes.Error, "screenshot upload failed")
			return Receipt{}, ErrStorageUnavailable
		}
		screenshotObject = objectMetadata(screenshotObject, request.Screenshot.MimeType)
		cleanup = append(cleanup, screenshotKey)
		capturedAt, _ := time.Parse(time.RFC3339Nano, request.Screenshot.CapturedAt)
		screenshotMetadataValue = &ScreenshotMetadata{ObjectKey: screenshotKey, ContentType: request.Screenshot.MimeType, Size: int64(len(data)), SHA256: sha256.Sum256(data), Width: request.Screenshot.Width, Height: request.Screenshot.Height, CapturedAt: capturedAt.UTC()}
		if screenshotObject.Size != int64(len(data)) || screenshotObject.SHA256 != screenshotMetadataValue.SHA256 {
			cleanupObjects()
			return Receipt{}, ErrStorageUnavailable
		}
	}

	report := Report{
		ID: reportID, TenantID: input.Context.TenantID, Category: request.Category, Source: request.Source, Message: request.Message,
		SubmitterKind: input.Context.SubmitterKind, SubmitterID: input.Context.SubmitterID, Environment: input.Context.Environment, Audience: input.Context.Audience,
		DiagnosticReference: input.Context.DiagnosticReference, TraceID: request.Evidence.Correlations.TraceID, SpanID: request.Evidence.Correlations.SpanID,
		RequestID: request.Evidence.Correlations.RequestID, CommandID: request.Evidence.Correlations.CommandID, IdempotencyKey: input.IdempotencyKey,
		RequestDigest: digest, EvidenceObjectKey: evidenceKey, EvidenceSize: int64(len(evidenceJSON)), EvidenceSHA256: evidenceDigest, EvidenceSchemaVersion: EvidenceSchemaVersion,
		ScreenshotFailureCode: input.Request.Evidence.Screenshot.FailureCode,
		Screenshot:            screenshotMetadataValue, CreatedAt: now, SubmittedAt: now,
	}
	setReportIDs(&report, input.Context, request.Evidence)
	if report.SubmissionTraceID == "" && incomingSpan.HasTraceID() {
		report.SubmissionTraceID = incomingSpan.TraceID().String()
	}
	if report.SubmissionSpanID == "" && incomingSpan.HasSpanID() {
		report.SubmissionSpanID = incomingSpan.SpanID().String()
	}
	created, err := s.repository.Create(ctx, CreateInput{Report: report})
	if err != nil {
		cleanupObjects()
		// A concurrent writer can win the unique idempotency race. Returning its
		// receipt preserves retry semantics without exposing database details.
		if existing, lookupErr = s.repository.GetByIdempotency(ctx, lookup); lookupErr == nil {
			if existing.RequestDigest != digest {
				return Receipt{}, ErrIdempotencyConflict
			}
			return existing.Receipt(), nil
		}
		return Receipt{}, err
	}
	return created.Receipt(), nil
}

func (s Service) Get(ctx context.Context, id utilities.ID) (report Report, resultErr error) {
	startedAt := time.Now()
	defer s.recordOperation(ctx, "get", startedAt, &resultErr)
	if id.IsZero() {
		return Report{}, ErrReportNotFound
	}
	if s.repository == nil {
		return Report{}, ErrRepositoryUnavailable
	}
	return s.repository.Get(ctx, id)
}

func (s Service) GetForTenant(ctx context.Context, tenantID, id utilities.ID) (report Report, resultErr error) {
	startedAt := time.Now()
	defer s.recordOperation(ctx, "get_for_tenant", startedAt, &resultErr)
	if tenantID.IsZero() || id.IsZero() {
		return Report{}, ErrReportNotFound
	}
	if s.repository == nil {
		return Report{}, ErrRepositoryUnavailable
	}
	return s.repository.GetForTenant(ctx, tenantID, id)
}

func (s Service) List(ctx context.Context, input ListInput) (result ListResult, resultErr error) {
	startedAt := time.Now()
	defer s.recordOperation(ctx, "list", startedAt, &resultErr)
	if input.Limit < 1 || input.Limit > 100 {
		input.Limit = 25
	}
	if input.TenantID != nil && input.TenantID.IsZero() {
		return ListResult{}, ErrReportNotFound
	}
	if s.repository == nil {
		return ListResult{}, ErrRepositoryUnavailable
	}
	return s.repository.List(ctx, input)
}

func (s Service) ReadEvidence(ctx context.Context, report Report) (object Object, resultErr error) {
	startedAt := time.Now()
	defer s.recordOperation(ctx, "read_evidence", startedAt, &resultErr)
	if report.EvidenceObjectKey == "" || s.objects == nil {
		return Object{}, ErrStorageUnavailable
	}
	object, err := s.objects.Get(ctx, report.EvidenceObjectKey)
	if err != nil || object.Size > MaxEvidenceDownloadBytes || object.Size != int64(len(object.Body)) {
		return Object{}, ErrStorageUnavailable
	}
	if object.SHA256 != report.EvidenceSHA256 || sha256.Sum256(object.Body) != report.EvidenceSHA256 {
		return Object{}, ErrStorageUnavailable
	}
	return object, nil
}

func (s Service) ReadScreenshot(ctx context.Context, report Report) (object Object, resultErr error) {
	startedAt := time.Now()
	defer s.recordOperation(ctx, "read_screenshot", startedAt, &resultErr)
	if report.Screenshot == nil || report.Screenshot.ObjectKey == "" {
		return Object{}, ErrReportNotFound
	}
	if s.objects == nil {
		return Object{}, ErrStorageUnavailable
	}
	object, err := s.objects.Get(ctx, report.Screenshot.ObjectKey)
	if err != nil || object.Size > MaxScreenshotDownloadBytes || object.Size != int64(len(object.Body)) {
		return Object{}, ErrStorageUnavailable
	}
	if object.SHA256 != report.Screenshot.SHA256 || sha256.Sum256(object.Body) != report.Screenshot.SHA256 {
		return Object{}, ErrStorageUnavailable
	}
	return object, nil
}

func (s Service) recordOperation(ctx context.Context, operation string, startedAt time.Time, resultErr *error) {
	if s.telemetry == nil {
		return
	}
	outcome, reason := feedbackOutcome(*resultErr)
	s.telemetry.RecordFeedback(ctx, operation, outcome, reason, time.Since(startedAt))
}

func feedbackOutcome(err error) (string, string) {
	switch {
	case err == nil:
		return "success", "none"
	case errors.Is(err, ErrInvalidRequest):
		return "rejected", "invalid_request"
	case errors.Is(err, ErrInvalidEvidence):
		return "rejected", "invalid_evidence"
	case errors.Is(err, ErrInvalidScreenshot):
		return "rejected", "invalid_screenshot"
	case errors.Is(err, ErrIdempotencyConflict):
		return "rejected", "idempotency_conflict"
	case errors.Is(err, ErrUnauthenticated):
		return "rejected", "unauthenticated"
	case errors.Is(err, ErrForbidden):
		return "rejected", "forbidden"
	case errors.Is(err, ErrReportNotFound):
		return "rejected", "not_found"
	case errors.Is(err, ErrStorageUnavailable):
		return "failure", "storage_unavailable"
	case errors.Is(err, ErrRepositoryUnavailable):
		return "failure", "repository_unavailable"
	default:
		return "failure", "internal"
	}
}

func validateContext(subject FeedbackContext, idempotencyKey string, source Source) error {
	if subject.TenantID.IsZero() || !validIdempotencyKey(idempotencyKey) || !validSource(source) {
		return ErrInvalidRequest
	}
	if subject.SubmitterKind != SubmitterAccount && subject.SubmitterKind != SubmitterParticipant {
		return ErrUnauthenticated
	}
	if strings.TrimSpace(subject.SubmitterID) == "" || len(subject.SubmitterID) > 256 {
		return ErrUnauthenticated
	}
	if subject.SubmitterKind == SubmitterAccount && source != SourceDashboard {
		return ErrForbidden
	}
	if subject.SubmitterKind == SubmitterParticipant && source == SourceDashboard {
		return ErrForbidden
	}
	return nil
}

func validIdempotencyKey(value string) bool {
	if len(value) < 16 || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') && (character < '0' || character > '9') && character != '_' && character != '-' {
			return false
		}
	}
	return true
}

func bindContext(subject FeedbackContext, request ReportRequest) error {
	if request.Evidence.Scope != nil {
		if !subject.SpaceID.IsZero() && request.Evidence.Scope.SpaceID != "" && request.Evidence.Scope.SpaceID != subject.SpaceID.String() {
			return ErrForbidden
		}
		if !subject.EpisodeID.IsZero() && request.Evidence.Scope.EpisodeID != "" && request.Evidence.Scope.EpisodeID != subject.EpisodeID.String() {
			return ErrForbidden
		}
		if !subject.ParticipantID.IsZero() && request.Evidence.Scope.ParticipantID != "" && request.Evidence.Scope.ParticipantID != subject.ParticipantID.String() {
			return ErrForbidden
		}
	}
	if subject.SubmitterKind == SubmitterParticipant && (subject.ParticipantID.IsZero() || subject.EpisodeID.IsZero() || subject.SpaceID.IsZero()) {
		return ErrUnauthenticated
	}
	return nil
}

func setReportIDs(report *Report, subject FeedbackContext, evidence FeedbackEvidence) {
	setID := func(value utilities.ID) *utilities.ID {
		if value.IsZero() {
			return nil
		}
		return &value
	}
	report.UserID = setID(subject.UserID)
	report.SpaceID = setID(subject.SpaceID)
	report.EpisodeID = setID(subject.EpisodeID)
	report.ParticipantID = setID(subject.ParticipantID)
	report.JourneyID = setID(subject.JourneyID)
	report.RootJourneyID = setID(subject.RootJourneyID)
	if report.JourneyID == nil {
		if journeyID, err := utilities.ParseID(evidence.Correlations.JourneyID); err == nil {
			report.JourneyID = setID(journeyID)
		}
	}
	if report.RootJourneyID == nil {
		if rootJourneyID, err := utilities.ParseID(evidence.Correlations.RootJourneyID); err == nil {
			report.RootJourneyID = setID(rootJourneyID)
		}
	}
	report.SubmissionJourneyID = setID(subject.JourneyID)
	if report.TraceID == "" {
		report.TraceID = subject.TraceID
	}
	if report.SpanID == "" {
		report.SpanID = subject.SpanID
	}
	report.SubmissionTraceID = subject.TraceID
	report.SubmissionSpanID = subject.SpanID
	if report.DiagnosticReference == "" {
		report.DiagnosticReference = evidence.Correlations.DiagnosticReference
	}
}

func Base64SHA256(data []byte) string {
	digest := sha256.Sum256(data)
	return base64.RawStdEncoding.EncodeToString(digest[:])
}
