package webhooks

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/trace"
)

type dispatcherRepositoryStub struct {
	claims       []Claim
	recoverErrs  int
	mu           sync.Mutex
	completed    int
	cleanupCalls int
	cleanupErrs  int
}

func (r *dispatcherRepositoryStub) RecoverExpired(context.Context) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.recoverErrs > 0 {
		r.recoverErrs--
		return 0, errors.New("database unavailable")
	}
	return 0, nil
}
func (r *dispatcherRepositoryStub) Claim(context.Context, string, int, time.Duration) ([]Claim, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	claims := r.claims
	r.claims = nil
	return claims, nil
}
func (*dispatcherRepositoryStub) RecordAttemptTrace(context.Context, Claim, string, string) error {
	return nil
}
func (r *dispatcherRepositoryStub) Complete(context.Context, Claim, AttemptResult) error {
	r.mu.Lock()
	r.completed++
	r.mu.Unlock()
	return nil
}
func (r *dispatcherRepositoryStub) Cleanup(context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cleanupCalls++
	if r.cleanupErrs > 0 {
		r.cleanupErrs--
		return errors.New("cleanup unavailable")
	}
	return nil
}

type concurrentSenderStub struct {
	mu      sync.Mutex
	active  int
	maximum int
	started chan struct{}
	gate    chan struct{}
}

func (s *concurrentSenderStub) Deliver(context.Context, DeliveryRequest) (DeliveryResponse, error) {
	s.mu.Lock()
	s.active++
	if s.active > s.maximum {
		s.maximum = s.active
	}
	s.mu.Unlock()
	s.started <- struct{}{}
	<-s.gate
	s.mu.Lock()
	s.active--
	s.mu.Unlock()
	return DeliveryResponse{Status: 204}, nil
}

func TestDispatcherRunsClaimedAttemptsConcurrently(t *testing.T) {
	protector, err := NewAESGCMProtector(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	tenantID, _ := utilities.ParseID("018bcfe5-6800-7000-8000-000000000001")
	endpointID, _ := utilities.ParseID("018bcfe5-6800-7000-8000-000000000002")
	revisionID, _ := utilities.ParseID("018bcfe5-6800-4000-8000-000000000003")
	urlCiphertext, _ := protector.Protect(URLScope(tenantID, endpointID, revisionID), []byte("https://example.com/hook"))
	secretCiphertext, _ := protector.Protect(SecretScope(tenantID, endpointID), []byte("secret"))
	repository := &dispatcherRepositoryStub{}
	for index := 0; index < 4; index++ {
		deliveryID, _ := utilities.NewID()
		eventID, _ := utilities.NewID()
		repository.claims = append(repository.claims, Claim{TenantID: tenantID, EndpointID: endpointID, EndpointRevisionID: revisionID, DeliveryID: deliveryID, EventID: eventID, AttemptNumber: 1, OccurredAt: time.Now(), Body: []byte("{}"), URLCiphertext: urlCiphertext, CurrentSecretCiphertext: secretCiphertext})
	}
	sender := &concurrentSenderStub{started: make(chan struct{}, 4), gate: make(chan struct{})}
	dispatcher := NewDispatcher(repository, protector, sender, "test", nil)
	done := make(chan error, 1)
	go func() { done <- dispatcher.runBatch(context.Background()) }()
	for index := 0; index < 4; index++ {
		select {
		case <-sender.started:
		case <-time.After(time.Second):
			t.Fatal("attempts did not start concurrently")
		}
	}
	close(sender.gate)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if sender.maximum != 4 || repository.completed != 4 {
		t.Fatalf("maximum=%d completed=%d", sender.maximum, repository.completed)
	}
}

func TestDispatcherRepositoryFailureDoesNotStopRuntime(t *testing.T) {
	repository := &dispatcherRepositoryStub{recoverErrs: 1}
	protector, _ := NewAESGCMProtector(make([]byte, 32))
	dispatcher := NewDispatcher(repository, protector, &concurrentSenderStub{}, "test", nil)
	dispatcher.poll = 5 * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := dispatcher.Run(ctx); err != nil {
		t.Fatalf("runtime stopped on recoverable repository failure: %v", err)
	}
}

func TestDispatcherCleansUpAtStartupAndOnConfiguredCadence(t *testing.T) {
	repository := &dispatcherRepositoryStub{}
	protector, _ := NewAESGCMProtector(make([]byte, 32))
	dispatcher := NewDispatcher(repository, protector, &concurrentSenderStub{}, "test", nil)
	dispatcher.poll = time.Hour
	dispatcher.cleanupEvery = 5 * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 18*time.Millisecond)
	defer cancel()
	if err := dispatcher.Run(ctx); err != nil {
		t.Fatal(err)
	}
	repository.mu.Lock()
	cleanupCalls := repository.cleanupCalls
	repository.mu.Unlock()
	if cleanupCalls < 2 {
		t.Fatalf("cleanup calls = %d, want startup plus scheduled cleanup", cleanupCalls)
	}
}

func TestWebhookAttemptUsesCrossServiceJourneySpanAttribute(t *testing.T) {
	t.Parallel()
	if journeySpanAttribute != "chalk.journey.id" {
		t.Fatalf("journey span attribute = %q", journeySpanAttribute)
	}
}

func TestDispatcherCompletionUsesInjectedLoggerWithContextAndRedaction(t *testing.T) {
	handler := &dispatcherLogHandler{}
	logger := slog.New(handler)
	repository := &dispatcherRepositoryStub{}
	dispatcher := NewDispatcher(repository, nil, nil, "test", logger)
	claim := Claim{
		JourneyID:     mustDispatcherID(t, "11111111-1111-4111-8111-111111111111"),
		EventID:       mustDispatcherID(t, "22222222-2222-4222-8222-222222222222"),
		DeliveryID:    mustDispatcherID(t, "33333333-3333-4333-8333-333333333333"),
		AttemptID:     mustDispatcherID(t, "44444444-4444-4444-8444-444444444444"),
		AttemptNumber: 1,
		EventName:     "session.ended",
		APIVersion:    APIVersion,
		Body:          []byte("private-webhook-body"),
	}
	traceID, err := trace.TraceIDFromHex("0af7651916cd43dd8448eb211c80319c")
	if err != nil {
		t.Fatal(err)
	}
	spanID, err := trace.SpanIDFromHex("b7ad6b7169203331")
	if err != nil {
		t.Fatal(err)
	}
	ctx := trace.ContextWithSpanContext(context.Background(), trace.NewSpanContext(trace.SpanContextConfig{TraceID: traceID, SpanID: spanID, Remote: true}))
	result := AttemptResult{Retryable: true, ErrorCode: "private-bearer-secret", HTTPStatus: http.StatusServiceUnavailable}

	if err := dispatcher.completeAttempt(ctx, trace.SpanFromContext(ctx), claim, result); err != nil {
		t.Fatalf("complete attempt: %v", err)
	}

	handler.mu.Lock()
	defer handler.mu.Unlock()
	if handler.message != "webhook delivery attempt completed" || handler.traceID != traceID {
		t.Fatalf("log message = %q trace = %s", handler.message, handler.traceID)
	}
	if handler.attributes["journey_id"] != claim.JourneyID.String() || handler.attributes["outcome"] != "retryable_failure" || handler.attributes["error_code"] != "other" {
		t.Fatalf("log attributes = %#v", handler.attributes)
	}
	serialized := handler.message
	for key, value := range handler.attributes {
		serialized += key + value
	}
	for _, secret := range []string{"private-webhook-body", "private-bearer-secret"} {
		if strings.Contains(serialized, secret) {
			t.Fatalf("completion log contains secret %q: %s", secret, serialized)
		}
	}
}

type dispatcherLogHandler struct {
	mu         sync.Mutex
	message    string
	attributes map[string]string
	traceID    trace.TraceID
}

func (*dispatcherLogHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h *dispatcherLogHandler) Handle(ctx context.Context, record slog.Record) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.message = record.Message
	h.traceID = trace.SpanContextFromContext(ctx).TraceID()
	h.attributes = make(map[string]string)
	record.Attrs(func(attribute slog.Attr) bool {
		h.attributes[attribute.Key] = attribute.Value.String()
		return true
	})
	return nil
}

func (h *dispatcherLogHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *dispatcherLogHandler) WithGroup(string) slog.Handler      { return h }

func mustDispatcherID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse dispatcher id: %v", err)
	}
	return id
}
