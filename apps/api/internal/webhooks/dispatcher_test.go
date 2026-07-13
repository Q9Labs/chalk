package webhooks

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
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
	dispatcher := NewDispatcher(repository, protector, sender, "test")
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
	dispatcher := NewDispatcher(repository, protector, &concurrentSenderStub{}, "test")
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
	dispatcher := NewDispatcher(repository, protector, &concurrentSenderStub{}, "test")
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
