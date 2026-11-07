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

func TestObservedInternalCleanupRequiresTerminalSessionError(t *testing.T) {
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
			publication := provideroperations.Publication{
				ParticipantID: testExecutorID(t, fixture.Publication.ParticipantID),
				Source:        fixture.Publication.Source,
				Enabled:       fixture.Publication.Enabled,
				PublicationID: fixture.Publication.PublicationID,
			}
			for _, retry := range []struct {
				name   string
				status int
				closed bool
			}{
				{name: "app not found stays unresolved", status: http.StatusNotFound},
				{name: "terminal session error completes", status: http.StatusGone, closed: true},
			} {
				t.Run(retry.name, func(t *testing.T) {
					repository, registry, client, service, input := newObservedCleanupScenario(
						t, observed.OperationID, observed.Receipt.Effect, observed.Receipt.State,
						observed.Receipt.Reason, observed.Receipt.LastErrorCode, publication,
						string(fixture.SessionResponse),
					)

					result, err := service.Execute(context.Background(), input)
					if err != nil {
						t.Fatal(err)
					}
					assertCleanupUnresolved(t, result, repository, registry, fixture.Publication.PublicationID, observed.Receipt.LastErrorCode)

					// The retained publication leaves room for an allocation that lands after the empty snapshot.
					calls := client.calls
					client.sessionStatus = retry.status
					result, err = service.Execute(context.Background(), input)
					if err != nil {
						t.Fatal(err)
					}
					if !retry.closed {
						assertCleanupUnresolved(t, result, repository, registry, fixture.Publication.PublicationID, observed.Receipt.LastErrorCode)
						if client.calls != calls+2 {
							t.Fatalf("404 retry calls = %d, want %d", client.calls, calls+2)
						}
						return
					}
					if result.Outcome != provideroperations.OutcomeSatisfied ||
						repository.receipt.State != provideroperations.ReceiptCompleted ||
						repository.receipt.LastErrorCode != nil ||
						registry.publication.PublicationID != "" ||
						client.calls != calls+2 {
						t.Fatalf("terminal session did not complete cleanup: result=%+v receipt=%+v publication=%+v calls=%d before=%d",
							result, repository.receipt, registry.publication, client.calls, calls)
					}

					calls = client.calls
					result, err = service.Execute(context.Background(), input)
					if err != nil || result.Outcome != provideroperations.OutcomeSatisfied || client.calls != calls {
						t.Fatalf("completed retry redispatched: result=%+v err=%v calls=%d before=%d", result, err, client.calls, calls)
					}
				})
			}
		})
	}
}

func newObservedCleanupScenario(
	t *testing.T,
	operationID string,
	effect provideroperations.Effect,
	state provideroperations.ReceiptState,
	reason string,
	lastErrorCode string,
	publication provideroperations.Publication,
	session string,
) (*failureReceiptRepository, *executorPublicationRegistry, *observedCleanupClient, Service, provideroperations.OperationInput) {
	t.Helper()
	input := testEndOperation(t)
	input.OperationID, input.Effect = operationID, effect
	if input.Effect == provideroperations.EffectRemoveParticipant {
		input.ParticipantID = publication.ParticipantID
		input.ParticipantGeneration = 1
	}

	repository := &failureReceiptRepository{}
	if _, err := repository.Prepare(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	repository.receipt.State = state
	repository.receipt.ParticipantID = input.ParticipantID
	repository.receipt.ParticipantGeneration = input.ParticipantGeneration
	repository.receipt.Reason = &reason
	repository.receipt.LastErrorCode = &lastErrorCode

	registry := &executorPublicationRegistry{publication: publication}
	client := &observedCleanupClient{t: t, session: session, sessionStatus: http.StatusOK}
	adapter, err := sfu.NewAdapterWithClient(config.CloudflareRealtimeConfig{
		RealtimeAppID: "test-app", RealtimeAppSecret: "test-secret", RequestTimeout: time.Second,
	}, client, "https://example.invalid")
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(repository, NewSFUExecutor(registry, adapter))
	return repository, registry, client, service, input
}

func assertCleanupUnresolved(
	t *testing.T,
	result Result,
	repository *failureReceiptRepository,
	registry *executorPublicationRegistry,
	publicationID string,
	lastErrorCode string,
) {
	t.Helper()
	if result.Outcome != provideroperations.OutcomeAmbiguous ||
		repository.receipt.State != provideroperations.ReceiptDispatching ||
		repository.receipt.LastErrorCode == nil ||
		*repository.receipt.LastErrorCode != lastErrorCode ||
		registry.publication.PublicationID != publicationID {
		t.Fatalf("unproven cleanup was discarded: result=%+v receipt=%+v publication=%+v",
			result, repository.receipt, registry.publication)
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
		body = `{"tracks":[{"mid":"0","errorCode":"internal_error","errorDescription":"Internal error"}]}`
	case request.Method == http.MethodGet && request.URL.Path == "/apps/test-app/sessions/retired-connection":
		status = c.sessionStatus
		if status == http.StatusNotFound {
			body = `{"errorCode":"not_found"}`
		}
		if status == http.StatusGone {
			body = `{"errorCode":"session_error","errorDescription":"Session has expired"}`
		}
	default:
		c.t.Fatalf("unexpected provider request: %s %s", request.Method, request.URL.Path)
	}
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body))}, nil
}
