package providerbridge

import (
	"context"
	"encoding/base64"
	"fmt"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestSFUExecutorBoundsIndependentSessionClosesAndRetainsPartialProgress(t *testing.T) {
	registry := &concurrentCloseRegistry{}
	for connection := range 6 {
		for mid := range 2 {
			payload := fmt.Sprintf(`{"c":"session-%d","m":"%d","t":"track-%d","g":1}`, connection, mid, mid)
			registry.publications = append(registry.publications, provideroperations.Publication{
				Source: "camera", PublicationID: "chalk_pub_v1." + base64.RawURLEncoding.EncodeToString([]byte(payload)),
			})
		}
	}
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
	publications []provideroperations.Publication
	closed       []mediapublications.CloseInput
}

func (r *concurrentCloseRegistry) Latest(context.Context, utilities.ID, utilities.ID) (mediapublications.Snapshot, error) {
	return mediapublications.Snapshot{Publications: r.publications}, nil
}

func (r *concurrentCloseRegistry) RecordClosedPublication(_ context.Context, input mediapublications.CloseInput) error {
	r.closed = append(r.closed, input)
	return nil
}
