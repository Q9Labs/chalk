package providerbridge

import (
	"context"
	"encoding/base64"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestSFUExecutorBoundsIndependentSessionClosesAndRetainsPartialProgress(t *testing.T) {
	registry := newConcurrentCloseRegistry(6)
	closer := &boundedSessionCloser{started: make(chan mediaplane.CloseTracksRequest, 6), release: make(chan struct{})}
	executor := NewSFUExecutor(registry, closer)
	result := make(chan ExecutionResult, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		result <- executor.Dispatch(ctx, provideroperations.OperationInput{Effect: provideroperations.EffectEndEpisode})
	}()

	for range 4 {
		select {
		case request := <-closer.started:
			if len(request.Tracks) != 2 || !request.Force {
				t.Fatal("session tracks must be batched in one forced close")
			}
		case <-time.After(time.Second):
			t.Fatal("independent SFU sessions did not close concurrently")
		}
	}
	select {
	case <-closer.started:
		t.Fatal("more than four SFU sessions closed concurrently")
	default:
	}
	close(closer.release)
	select {
	case got := <-result:
		if got.Outcome == provideroperations.OutcomeConfirmed || len(registry.closed) != 10 {
			t.Fatalf("failed session must remain unresolved while successful siblings are recorded: outcome=%s recorded=%d", got.Outcome, len(registry.closed))
		}
	case <-time.After(time.Second):
		t.Fatal("bounded close did not finish")
	}
}

func TestSFUExecutorRecordsCompletedSessionBeforeSlowerSibling(t *testing.T) {
	registry := newConcurrentCloseRegistry(2)
	registry.closedNotify = make(chan struct{}, 4)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan ExecutionResult, 1)
	go func() {
		result <- NewSFUExecutor(registry, slowSiblingCloser{}).Dispatch(ctx, provideroperations.OperationInput{Effect: provideroperations.EffectEndEpisode})
	}()
	select {
	case <-registry.closedNotify:
	case <-time.After(time.Second):
		t.Fatal("completed session was not recorded while its sibling remained pending")
	}
	cancel()
	select {
	case got := <-result:
		if got.Outcome == provideroperations.OutcomeConfirmed || len(registry.closed) != 2 {
			t.Fatalf("deadline must retain completed session: outcome=%s recorded=%d", got.Outcome, len(registry.closed))
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled close did not finish")
	}
}

func newConcurrentCloseRegistry(sessions int) *concurrentCloseRegistry {
	registry := &concurrentCloseRegistry{}
	for connection := range sessions {
		for mid := range 2 {
			payload := fmt.Sprintf(`{"c":"session-%d","m":"%d","t":"track-%d","g":1}`, connection, mid, mid)
			registry.publications = append(registry.publications, provideroperations.Publication{
				Source: "camera", PublicationID: "chalk_pub_v1." + base64.RawURLEncoding.EncodeToString([]byte(payload)),
			})
		}
	}
	return registry
}

type slowSiblingCloser struct{}

func (slowSiblingCloser) CloseTracks(ctx context.Context, input mediaplane.CloseTracksRequest) (mediaplane.CloseTracksResponse, error) {
	if input.ConnectionID == "session-1" {
		<-ctx.Done()
		return mediaplane.CloseTracksResponse{}, ctx.Err()
	}
	return mediaplane.CloseTracksResponse{}, nil
}

type boundedSessionCloser struct {
	started chan mediaplane.CloseTracksRequest
	release chan struct{}
}

func (c *boundedSessionCloser) CloseTracks(ctx context.Context, input mediaplane.CloseTracksRequest) (mediaplane.CloseTracksResponse, error) {
	c.started <- input
	select {
	case <-c.release:
	case <-ctx.Done():
		return mediaplane.CloseTracksResponse{}, ctx.Err()
	}
	if input.ConnectionID == "session-0" {
		return mediaplane.CloseTracksResponse{}, mediaplane.ErrProviderFailed
	}
	return mediaplane.CloseTracksResponse{}, nil
}

type concurrentCloseRegistry struct {
	executorPublicationRegistry
	mu           sync.Mutex
	closedNotify chan struct{}
	publications []provideroperations.Publication
	closed       []mediapublications.CloseInput
}

func (r *concurrentCloseRegistry) Latest(context.Context, utilities.ID, utilities.ID) (mediapublications.Snapshot, error) {
	return mediapublications.Snapshot{Publications: r.publications}, nil
}

func (r *concurrentCloseRegistry) RecordClosedPublication(_ context.Context, input mediapublications.CloseInput) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = append(r.closed, input)
	if r.closedNotify != nil {
		r.closedNotify <- struct{}{}
	}
	return nil
}
