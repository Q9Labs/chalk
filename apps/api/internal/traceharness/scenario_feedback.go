package traceharness

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/feedback"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type feedbackTraceRepository struct {
	report    feedback.Report
	createErr error
}

func (r *feedbackTraceRepository) GetByIdempotency(context.Context, feedback.IdempotencyLookup) (feedback.Report, error) {
	if r.report.ID.IsZero() {
		return feedback.Report{}, feedback.ErrReportNotFound
	}
	return r.report, nil
}

func (r *feedbackTraceRepository) Create(_ context.Context, input feedback.CreateInput) (feedback.Report, error) {
	if r.createErr != nil {
		return feedback.Report{}, r.createErr
	}
	r.report = input.Report
	return input.Report, nil
}

func (r *feedbackTraceRepository) Get(context.Context, utilities.ID) (feedback.Report, error) {
	return r.report, nil
}

func (r *feedbackTraceRepository) GetForTenant(context.Context, utilities.ID, utilities.ID) (feedback.Report, error) {
	return r.report, nil
}

func (r *feedbackTraceRepository) List(context.Context, feedback.ListInput) (feedback.ListResult, error) {
	return feedback.ListResult{}, nil
}

type feedbackTraceObjectStore struct {
	puts    int
	objects map[string]feedback.Object
}

func (s *feedbackTraceObjectStore) Put(_ context.Context, key, contentType string, body []byte) (feedback.Object, error) {
	s.puts++
	if s.objects == nil {
		s.objects = make(map[string]feedback.Object)
	}
	object := feedback.Object{Key: key, ContentType: contentType, Size: int64(len(body)), SHA256: sha256.Sum256(body), Body: append([]byte(nil), body...)}
	s.objects[key] = object
	return object, nil
}

func (s *feedbackTraceObjectStore) Get(_ context.Context, key string) (feedback.Object, error) {
	object, ok := s.objects[key]
	if !ok {
		return feedback.Object{}, errors.New("trace object not found")
	}
	return object, nil
}

func (s *feedbackTraceObjectStore) Delete(_ context.Context, key string) error {
	delete(s.objects, key)
	return nil
}

func runServiceFeedbackSubmission(ctx context.Context) (ScenarioResult, error) {
	recorder := NewRecorder(deterministicClock())
	repository := &feedbackTraceRepository{}
	objects := &feedbackTraceObjectStore{}
	service := feedback.NewService(repository, objects).WithClock(deterministicClock())
	recorder.Add("scenario", ServiceFeedbackSubmissionScenario, "submit one bounded Feedback Report", map[string]any{"source": "embedded", "redaction": "message, evidence, object keys, and credentials omitted"})
	recorder.Add("http", "POST /v1/feedback-reports", "verified participant request entered the Feedback service", map[string]any{"auth": "episode_diagnostics_participant", "idempotency": "bound to submitter"})
	recorder.Add("service", "feedback.Service.Submit", "validated and bound the report to its participant subject", map[string]any{"category": "bug", "evidence_limit": feedback.MaxEvidenceBytes, "screenshot": false})
	receipt, err := service.Submit(ctx, feedback.SubmitInput{Context: feedbackTraceContext(), IdempotencyKey: "trace-feedback-key", Request: feedbackTraceRequest()})
	if err != nil {
		return ScenarioResult{}, err
	}
	recorder.Add("objectstore", "PUT feedback evidence", "stored the versioned evidence object", map[string]any{"bytes": repository.report.EvidenceSize, "checksum": "omitted"})
	recorder.Add("database", "INSERT feedback_reports", "committed the complete report row", map[string]any{"report": "created", "receipt": "returned"})
	recorder.Add("service", "feedback.Service.Submit", "returned the receipt", map[string]any{"idempotent": true, "report_id": "omitted"})
	body, err := json.Marshal(map[string]any{"idempotent": true, "evidence_stored": true, "receipt_schema": receipt.SchemaVersion})
	if err != nil {
		return ScenarioResult{}, err
	}
	return ScenarioResult{Name: ServiceFeedbackSubmissionScenario, StatusCode: 201, Body: body, Events: recorder.Events()}, nil
}

func runEdgeFeedbackValidationFailure(ctx context.Context) (ScenarioResult, error) {
	recorder := NewRecorder(deterministicClock())
	repository := &feedbackTraceRepository{}
	objects := &feedbackTraceObjectStore{}
	service := feedback.NewService(repository, objects).WithClock(deterministicClock())
	recorder.Add("scenario", EdgeFeedbackValidationFailureScenario, "reject unsafe Feedback input before persistence", map[string]any{"redaction": "payload and credentials omitted"})
	recorder.Add("service", "feedback.Service.Submit", "rejected a control character before writing objects", map[string]any{"validation": "request.invalid"})
	request := feedbackTraceRequest()
	request.Message = "bad\x00message"
	_, err := service.Submit(ctx, feedback.SubmitInput{Context: feedbackTraceContext(), IdempotencyKey: "trace-feedback-key", Request: request})
	if !errors.Is(err, feedback.ErrInvalidRequest) {
		return ScenarioResult{}, fmt.Errorf("validation result = %v", err)
	}
	recorder.Add("return", "request.invalid", "returned a safe validation error", map[string]any{"status": 400, "content": "omitted", "objects_written": objects.puts})
	body, marshalErr := json.Marshal(map[string]any{"objects_written": objects.puts > 0, "status": 400, "error": "request.invalid"})
	if marshalErr != nil {
		return ScenarioResult{}, marshalErr
	}
	return ScenarioResult{Name: EdgeFeedbackValidationFailureScenario, StatusCode: 400, Body: body, Events: recorder.Events()}, nil
}

func feedbackTraceContext() feedback.FeedbackContext {
	tenantID := traceFeedbackID("11111111-1111-4111-8111-111111111111")
	spaceID := traceFeedbackID("22222222-2222-4222-8222-222222222222")
	episodeID := traceFeedbackID("33333333-3333-4333-8333-333333333333")
	participantID := traceFeedbackID("44444444-4444-4444-8444-444444444444")
	return feedback.FeedbackContext{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID, SubmitterKind: feedback.SubmitterParticipant, SubmitterID: participantID.String(), Environment: "development", Audience: "chalk-diagnostics"}
}

func feedbackTraceRequest() feedback.ReportRequest {
	return feedback.ReportRequest{SchemaVersion: feedback.ReportSchemaVersion, Category: feedback.CategoryBug, Message: "The reconnect button failed", Source: feedback.SourceEmbedded, Evidence: feedback.FeedbackEvidence{SchemaVersion: feedback.EvidenceSchemaVersion, CollectedAt: "2026-08-19T12:00:00Z", SDK: feedback.FeedbackSDK{Client: "chalk-client/trace"}, Platform: feedback.FeedbackPlatform{Kind: "web", DeviceClass: "desktop"}, Diagnostics: feedback.FeedbackDiagnostics{Availability: "available"}, LocalState: feedback.FeedbackLocalState{RegistryVersion: "FeedbackLocalState/v1"}, Cookies: feedback.FeedbackCookies{RegistryVersion: "FeedbackCookies/v1"}, Screenshot: feedback.FeedbackScreenshotState{State: "unavailable"}}}
}

func traceFeedbackID(value string) utilities.ID {
	id, _ := utilities.ParseID(value)
	return id
}

var _ feedback.Repository = (*feedbackTraceRepository)(nil)
var _ feedback.ObjectStore = (*feedbackTraceObjectStore)(nil)
