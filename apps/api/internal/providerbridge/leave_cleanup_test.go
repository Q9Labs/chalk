package providerbridge

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
)

func TestLeaveCleanupPreservesRejoinedGeneration(t *testing.T) {
	participantID := testExecutorID(t, "33333333-3333-4333-8333-333333333333")
	publicationID := "chalk_pub_v1." + base64.RawURLEncoding.EncodeToString([]byte(`{"c":"rejoined-connection","m":"0","t":"camera","g":2}`))
	registry := &executorPublicationRegistry{publication: provideroperations.Publication{ParticipantID: participantID, Source: "camera", Enabled: true, PublicationID: publicationID}}
	closer := &executorTrackCloser{}
	executor := NewSFUExecutor(registry, closer)
	operation := provideroperations.OperationInput{ParticipantID: participantID, ParticipantGeneration: 1, Effect: provideroperations.EffectRemoveParticipant}
	if result := executor.Dispatch(context.Background(), operation); result.Outcome != provideroperations.OutcomeSatisfied {
		t.Fatalf("old cleanup outcome = %+v", result)
	}
	if closer.calls != 0 || registry.publication.PublicationID != publicationID || !registry.publication.Enabled {
		t.Fatalf("old cleanup changed rejoined publication: calls=%d publication=%+v", closer.calls, registry.publication)
	}
}

func TestLeaveCleanupCloudflare410IsSatisfiedAndReplayable(t *testing.T) {
	participantID := testExecutorID(t, "33333333-3333-4333-8333-333333333333")
	publicationID := "chalk_pub_v1." + base64.RawURLEncoding.EncodeToString([]byte(`{"c":"departed-connection","m":"0","t":"camera","g":1}`))
	registry := &executorPublicationRegistry{publication: provideroperations.Publication{ParticipantID: participantID, Source: "camera", Enabled: true, PublicationID: publicationID}}
	client := &goneCleanupClient{}
	adapter, err := sfu.NewAdapterWithClient(config.CloudflareRealtimeConfig{RealtimeAppID: "test-app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second}, client, "https://example.invalid")
	if err != nil {
		t.Fatal(err)
	}
	executor := NewSFUExecutor(registry, adapter)
	operation := provideroperations.OperationInput{ParticipantID: participantID, ParticipantGeneration: 1, Effect: provideroperations.EffectRemoveParticipant}
	for range 2 {
		if result := executor.Dispatch(context.Background(), operation); result.Outcome != provideroperations.OutcomeSatisfied {
			t.Fatalf("410 cleanup outcome = %+v", result)
		}
	}
	if client.calls != 1 || registry.publication.PublicationID != "" {
		t.Fatalf("410 cleanup did not converge: calls=%d publication=%+v", client.calls, registry.publication)
	}
}

type goneCleanupClient struct{ calls int }

func (c *goneCleanupClient) Do(*http.Request) (*http.Response, error) {
	c.calls++
	return &http.Response{StatusCode: http.StatusGone, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
}
