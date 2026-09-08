package feedback

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type feedbackRepositoryStub struct {
	report       Report
	lookupErrors []error
	createErr    error
	creates      int
}

func (s *feedbackRepositoryStub) GetByIdempotency(context.Context, IdempotencyLookup) (Report, error) {
	if s.report.ID.IsZero() {
		if len(s.lookupErrors) > 0 {
			err := s.lookupErrors[0]
			s.lookupErrors = s.lookupErrors[1:]
			return Report{}, err
		}
		return Report{}, ErrReportNotFound
	}
	return s.report, nil
}

func (s *feedbackRepositoryStub) Create(_ context.Context, input CreateInput) (Report, error) {
	s.creates++
	if s.createErr != nil {
		return Report{}, s.createErr
	}
	s.report = input.Report
	return input.Report, nil
}

func (s *feedbackRepositoryStub) Get(context.Context, utilities.ID) (Report, error) {
	return s.report, nil
}

func (s *feedbackRepositoryStub) GetForTenant(context.Context, utilities.ID, utilities.ID) (Report, error) {
	return s.report, nil
}

func (s *feedbackRepositoryStub) List(context.Context, ListInput) (ListResult, error) {
	return ListResult{}, nil
}

type feedbackObjectStoreStub struct {
	objects      map[string]Object
	putCalls     int
	deleteKeys   []string
	failPutAfter int
}

func (s *feedbackObjectStoreStub) Put(_ context.Context, key, contentType string, body []byte) (Object, error) {
	s.putCalls++
	if s.failPutAfter > 0 && s.putCalls >= s.failPutAfter {
		return Object{}, errors.New("object store write failed")
	}
	if s.objects == nil {
		s.objects = make(map[string]Object)
	}
	object := Object{Key: key, ContentType: contentType, Size: int64(len(body)), SHA256: sha256.Sum256(body), Body: append([]byte(nil), body...)}
	s.objects[key] = object
	return object, nil
}

func (s *feedbackObjectStoreStub) Get(_ context.Context, key string) (Object, error) {
	object, ok := s.objects[key]
	if !ok {
		return Object{}, errors.New("object not found")
	}
	return object, nil
}

func (s *feedbackObjectStoreStub) Delete(_ context.Context, key string) error {
	s.deleteKeys = append(s.deleteKeys, key)
	delete(s.objects, key)
	return nil
}

func feedbackContextFixture(t *testing.T) FeedbackContext {
	t.Helper()
	tenantID := mustFeedbackID(t, "11111111-1111-4111-8111-111111111111")
	spaceID := mustFeedbackID(t, "22222222-2222-4222-8222-222222222222")
	episodeID := mustFeedbackID(t, "33333333-3333-4333-8333-333333333333")
	participantID := mustFeedbackID(t, "44444444-4444-4444-8444-444444444444")
	return FeedbackContext{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID, SubmitterKind: SubmitterParticipant, SubmitterID: participantID.String(), Environment: "development", Audience: "chalk-diagnostics"}
}

func feedbackRequestFixture() ReportRequest {
	return ReportRequest{
		SchemaVersion: ReportSchemaVersion,
		Category:      CategoryBug,
		Message:       "  The reconnect button did not recover the Space.  ",
		Source:        SourceEmbedded,
		Evidence: FeedbackEvidence{
			SchemaVersion: EvidenceSchemaVersion,
			CollectedAt:   "2026-08-19T12:00:00Z",
			SDK:           FeedbackSDK{Client: "chalk-client/1"},
			Platform:      FeedbackPlatform{Kind: "web", DeviceClass: "desktop"},
			Correlations:  FeedbackCorrelations{},
			Diagnostics:   FeedbackDiagnostics{Availability: "available"},
			LocalState:    FeedbackLocalState{RegistryVersion: "FeedbackLocalState/v1"},
			Cookies:       FeedbackCookies{RegistryVersion: "FeedbackCookies/v1"},
			Screenshot:    FeedbackScreenshotState{State: "unavailable"},
		},
	}
}

func mustFeedbackID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse feedback fixture id: %v", err)
	}
	return id
}

func TestServiceSubmitReplayAndConflict(t *testing.T) {
	repository := &feedbackRepositoryStub{lookupErrors: []error{ErrReportNotFound}}
	objects := &feedbackObjectStoreStub{}
	service := NewService(repository, objects).WithClock(func() time.Time { return time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC) })
	input := SubmitInput{Context: feedbackContextFixture(t), IdempotencyKey: "feedback-key-123456", Request: feedbackRequestFixture()}

	first, err := service.Submit(context.Background(), input)
	if err != nil {
		t.Fatalf("first submit: %v", err)
	}
	replay, err := service.Submit(context.Background(), input)
	if err != nil {
		t.Fatalf("replay submit: %v", err)
	}
	if first != replay {
		t.Fatalf("replay receipt = %#v, want %#v", replay, first)
	}
	if repository.creates != 1 || objects.putCalls != 1 {
		t.Fatalf("replay rewrote state: creates=%d puts=%d", repository.creates, objects.putCalls)
	}

	changed := input
	changed.Request.Message = "A different report"
	if _, err := service.Submit(context.Background(), changed); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("changed content error = %v, want idempotency conflict", err)
	}
}

func TestServiceSubmitDatabaseFailureCompensatesObjects(t *testing.T) {
	repository := &feedbackRepositoryStub{lookupErrors: []error{ErrReportNotFound}, createErr: errors.New("database unavailable")}
	objects := &feedbackObjectStoreStub{}
	service := NewService(repository, objects)

	if _, err := service.Submit(context.Background(), SubmitInput{Context: feedbackContextFixture(t), IdempotencyKey: "feedback-key-123456", Request: feedbackRequestFixture()}); err == nil {
		t.Fatal("database failure returned nil error")
	}
	if len(objects.deleteKeys) != 1 {
		t.Fatalf("compensation deletes = %d, want 1", len(objects.deleteKeys))
	}
}

func TestServiceSubmitScreenshotFailureCompensatesEvidence(t *testing.T) {
	repository := &feedbackRepositoryStub{lookupErrors: []error{ErrReportNotFound}}
	objects := &feedbackObjectStoreStub{failPutAfter: 2}
	service := NewService(repository, objects)
	request := feedbackRequestFixture()
	request.Screenshot = &FeedbackScreenshot{SchemaVersion: ScreenshotSchemaVersion, MimeType: "image/png", Width: 1, Height: 1, CapturedAt: "2026-08-19T12:00:00Z", DataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}
	request.Evidence.Screenshot = FeedbackScreenshotState{State: "captured", CapturedAt: request.Screenshot.CapturedAt}

	if _, err := service.Submit(context.Background(), SubmitInput{Context: feedbackContextFixture(t), IdempotencyKey: "feedback-key-123456", Request: request}); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("screenshot failure error = %v, want storage unavailable", err)
	}
	if len(objects.deleteKeys) != 1 {
		t.Fatalf("compensation deletes = %d, want 1", len(objects.deleteKeys))
	}
}

func TestReportRequestValidationRejectsUnsafeInput(t *testing.T) {
	request := feedbackRequestFixture()
	request.Message = "unsafe\x00message"
	if _, _, _, err := request.validate(); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("control character error = %v, want invalid request", err)
	}
	request = feedbackRequestFixture()
	request.Screenshot = &FeedbackScreenshot{SchemaVersion: ScreenshotSchemaVersion, MimeType: "image/png", Width: 1921, Height: 1, CapturedAt: "2026-08-19T12:00:00Z", DataBase64: "aW1hZ2U="}
	if _, _, _, err := request.validate(); !errors.Is(err, ErrInvalidScreenshot) {
		t.Fatalf("screenshot bounds error = %v, want invalid screenshot", err)
	}
}

var _ Repository = (*feedbackRepositoryStub)(nil)
var _ ObjectStore = (*feedbackObjectStoreStub)(nil)
