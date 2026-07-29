package whiteboardfiles

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestCleanupDeletesObjectsBeforeRowsAndHonorsCycleBound(t *testing.T) {
	now := time.Date(2026, time.July, 29, 12, 0, 0, 0, time.UTC)
	events := []string{}
	repository := &cleanupRepositoryStub{
		events: &events,
		batches: [][]CleanupClaim{
			{cleanupClaim(t, "1"), cleanupClaim(t, "2")},
			{cleanupClaim(t, "3"), cleanupClaim(t, "4")},
			{cleanupClaim(t, "5")},
		},
	}
	objects := &cleanupObjectStoreStub{
		events: &events,
		errByKey: map[string]error{
			cleanupClaim(t, "2").ObjectKey: objectstorage.ErrObjectNotFound,
		},
	}
	worker := NewCleanupWorker(repository, objects)
	worker.now = func() time.Time { return now }
	worker.batchSize = 2
	worker.maxBatches = 2

	result, err := worker.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result != (CleanupResult{Batches: 2, Claimed: 4, Deleted: 4}) {
		t.Fatalf("result = %#v", result)
	}
	if len(repository.inputs) != 2 {
		t.Fatalf("claim calls = %d, want 2", len(repository.inputs))
	}
	input := repository.inputs[0]
	if input.Now != now || input.EndedBefore != now.Add(-7*24*time.Hour) ||
		input.LeaseUntil != now.Add(cleanupLeaseDuration) || input.Limit != 2 {
		t.Fatalf("claim input = %#v", input)
	}

	wantEvents := []string{
		"delete:object-1", "complete:object-1",
		"delete:object-2", "complete:object-2",
		"delete:object-3", "complete:object-3",
		"delete:object-4", "complete:object-4",
	}
	if fmt.Sprint(events) != fmt.Sprint(wantEvents) {
		t.Fatalf("events = %#v, want %#v", events, wantEvents)
	}
}

func TestCleanupKeepsRowsWhenProviderDeletionFailsAndContinues(t *testing.T) {
	events := []string{}
	failed := cleanupClaim(t, "1")
	succeeded := cleanupClaim(t, "2")
	repository := &cleanupRepositoryStub{
		events:  &events,
		batches: [][]CleanupClaim{{failed, succeeded}},
	}
	objects := &cleanupObjectStoreStub{
		events:   &events,
		errByKey: map[string]error{failed.ObjectKey: objectstorage.ErrProviderFailed},
	}
	worker := NewCleanupWorker(repository, objects)
	worker.batchSize = 10

	result, err := worker.Run(context.Background())
	if !errors.Is(err, objectstorage.ErrProviderFailed) {
		t.Fatalf("error = %v", err)
	}
	if result != (CleanupResult{Batches: 1, Claimed: 2, Deleted: 1, Failed: 1}) {
		t.Fatalf("result = %#v", result)
	}
	if fmt.Sprint(events) != fmt.Sprint([]string{
		"delete:object-1", "delete:object-2", "complete:object-2",
	}) {
		t.Fatalf("events = %#v", events)
	}
}

func TestCleanupTraceUsesOnlyBoundedAggregateFields(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	originalTracer := cleanupTracer
	cleanupTracer = provider.Tracer("whiteboard-cleanup-test")
	t.Cleanup(func() {
		cleanupTracer = originalTracer
		_ = provider.Shutdown(context.Background())
	})

	claim := cleanupClaim(t, "private-object-key")
	repository := &cleanupRepositoryStub{batches: [][]CleanupClaim{{claim}}}
	objects := &cleanupObjectStoreStub{}
	worker := NewCleanupWorker(repository, objects)

	if _, err := worker.Run(context.Background()); err != nil {
		t.Fatal(err)
	}

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("ended spans = %d, want 1", len(spans))
	}
	telemetry := fmt.Sprint(
		spans[0].Name(),
		spans[0].Attributes(),
		spans[0].Events(),
		spans[0].Status(),
	)
	for _, required := range []string{
		"whiteboard_files.cleanup",
		"chalk.whiteboard_files.cleanup.outcome",
		"chalk.whiteboard_files.cleanup.claimed",
		"succeeded",
	} {
		if !strings.Contains(telemetry, required) {
			t.Fatalf("telemetry missing %q: %s", required, telemetry)
		}
	}
	if strings.Contains(telemetry, claim.ObjectKey) {
		t.Fatalf("telemetry leaked object key: %s", telemetry)
	}
}

type cleanupRepositoryStub struct {
	batches [][]CleanupClaim
	inputs  []CleanupClaimInput
	events  *[]string
	err     error
}

func (s *cleanupRepositoryStub) ClaimCleanup(_ context.Context, input CleanupClaimInput) ([]CleanupClaim, error) {
	s.inputs = append(s.inputs, input)
	if s.err != nil {
		return nil, s.err
	}
	if len(s.batches) == 0 {
		return nil, nil
	}
	claims := s.batches[0]
	s.batches = s.batches[1:]
	return claims, nil
}

func (s *cleanupRepositoryStub) CompleteCleanup(_ context.Context, claim CleanupClaim) error {
	if s.events != nil {
		*s.events = append(*s.events, "complete:"+claim.ObjectKey)
	}
	return s.err
}

type cleanupObjectStoreStub struct {
	events   *[]string
	errByKey map[string]error
}

func (s *cleanupObjectStoreStub) DeleteObject(_ context.Context, key string) error {
	if s.events != nil {
		*s.events = append(*s.events, "delete:"+key)
	}
	return s.errByKey[key]
}

func cleanupClaim(t *testing.T, suffix string) CleanupClaim {
	t.Helper()
	uploadID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	token, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return CleanupClaim{UploadID: uploadID, ObjectKey: "object-" + suffix, Token: token}
}
