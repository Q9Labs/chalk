package providerbridge

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
)

func TestObservedInternalCleanupRequiresSessionGone(t *testing.T) {
	data, err := os.ReadFile("testdata/end-cleanup-2026-10-29.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Operations []struct {
			OperationID string `json:"operation_id"`
			Receipt     struct {
				Effect        provideroperations.Effect       `json:"effect"`
				State         provideroperations.ReceiptState `json:"state"`
				Reason        string                          `json:"reason"`
				LastErrorCode string                          `json:"last_error_code"`
			} `json:"receipt"`
		} `json:"operations"`
		Publication struct {
			ParticipantID string `json:"participant_id"`
			Source        string `json:"source"`
			Enabled       bool   `json:"enabled"`
			PublicationID string `json:"publication_id"`
		} `json:"publication"`
		SessionResponse json.RawMessage `json:"session_response"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Operations) != 2 {
		t.Fatal("fixture must include the pending end and leave receipts")
	}
	for _, observed := range fixture.Operations {
		t.Run(string(observed.Receipt.Effect), func(t *testing.T) {
			for _, session := range []struct {
				name     string
				status   int
				complete bool
			}{
				{name: "observed empty session stays unresolved", status: http.StatusOK},
				{name: "session later not found", status: http.StatusNotFound, complete: true},
				{name: "session later gone", status: http.StatusGone, complete: true},
			} {
				t.Run(session.name, func(t *testing.T) {
					publication := provideroperations.Publication{ParticipantID: testExecutorID(t, fixture.Publication.ParticipantID), Source: fixture.Publication.Source, Enabled: fixture.Publication.Enabled, PublicationID: fixture.Publication.PublicationID}
					input := testEndOperation(t)
					input.OperationID, input.Effect = observed.OperationID, observed.Receipt.Effect
					if input.Effect == provideroperations.EffectRemoveParticipant {
						input.ParticipantID = publication.ParticipantID
						input.ParticipantGeneration = 1
					}
					repository := &failureReceiptRepository{}
					if _, err := repository.Prepare(context.Background(), input); err != nil {
						t.Fatal(err)
					}
					repository.receipt.State = observed.Receipt.State
					repository.receipt.ParticipantID = input.ParticipantID
					repository.receipt.ParticipantGeneration = input.ParticipantGeneration
					repository.receipt.Reason = &observed.Receipt.Reason
					repository.receipt.LastErrorCode = &observed.Receipt.LastErrorCode
					registry := &executorPublicationRegistry{publication: publication}
					client := &observedCleanupClient{t: t, session: string(fixture.SessionResponse), sessionStatus: http.StatusOK}
					adapter, err := sfu.NewAdapterWithClient(config.CloudflareRealtimeConfig{RealtimeAppID: "test-app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second}, client, "https://example.invalid")
					if err != nil {
						t.Fatal(err)
					}
					service := NewService(repository, NewSFUExecutor(registry, adapter))
					result, err := service.Execute(context.Background(), input)
					if err != nil {
						t.Fatal(err)
					}
					if result.Outcome != provideroperations.OutcomeAmbiguous || repository.receipt.State != provideroperations.ReceiptDispatching || repository.receipt.LastErrorCode == nil || *repository.receipt.LastErrorCode != observed.Receipt.LastErrorCode || registry.publication.PublicationID != fixture.Publication.PublicationID {
						t.Fatalf("empty snapshot discarded unresolved cleanup: result=%+v receipt_state=%s publication=%+v", result, repository.receipt.State, registry.publication)
					}
					calls := client.calls
					// Counterfactual recovery: only the provider session's terminal
					// status changes; retry the same dispatching receipt.
					client.sessionStatus = session.status
					result, err = service.Execute(context.Background(), input)
					if err != nil {
						t.Fatal(err)
					}
					if session.complete {
						if result.Outcome != provideroperations.OutcomeSatisfied || repository.receipt.State != provideroperations.ReceiptCompleted || repository.receipt.LastErrorCode != nil || registry.publication.PublicationID != "" || client.calls != calls+2 {
							t.Fatalf("gone session did not recover: result=%+v receipt_state=%s calls=%d before=%d", result, repository.receipt.State, client.calls, calls)
						}
						calls = client.calls
						result, err = service.Execute(context.Background(), input)
						if err != nil || result.Outcome != provideroperations.OutcomeSatisfied || calls != client.calls {
							t.Fatalf("completed retry redispatched: result=%+v err=%v calls=%d before=%d", result, err, client.calls, calls)
						}
					} else if result.Outcome != provideroperations.OutcomeAmbiguous || client.calls != calls+2 || registry.publication.PublicationID != fixture.Publication.PublicationID {
						t.Fatalf("unresolved cleanup must retry provider and retain publication: result=%+v calls=%d before=%d", result, client.calls, calls)
					}
				})
			}
		})
	}
}

type observedCleanupClient struct {
	t             *testing.T
	session       string
	sessionStatus int
	calls         int
}

func (c *observedCleanupClient) Do(request *http.Request) (*http.Response, error) {
	c.calls++
	body := c.session
	status := http.StatusOK
	switch {
	case request.Method == http.MethodPut && request.URL.Path == "/apps/test-app/sessions/retired-connection/tracks/close":
		// Reconstruct the observed normalized failure, not an unavailable raw body.
		body = `{"tracks":[{"mid":"0","errorCode":"internal_error","errorDescription":"Internal error"}]}`
	case request.Method == http.MethodGet && request.URL.Path == "/apps/test-app/sessions/retired-connection":
		status = c.sessionStatus
	default:
		c.t.Fatalf("unexpected provider request: %s %s", request.Method, request.URL.Path)
	}
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body))}, nil
}
