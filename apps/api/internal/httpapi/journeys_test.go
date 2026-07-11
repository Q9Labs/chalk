package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/journeys"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type journeyService struct {
	intake func(context.Context, journeys.IntakeInput) (journeys.IntakeResult, error)
	get    func(context.Context, utilities.ID) (journeys.Ledger, error)
}

type journeyMetrics struct {
	rejected int
}

type meetingCredentialVerifier struct {
	verify func(context.Context, string) error
}

func (v meetingCredentialVerifier) Verify(ctx context.Context, credential string) error {
	return v.verify(ctx, credential)
}

func (*journeyMetrics) RecordJourneyIntake(context.Context, int, int) {}

func (m *journeyMetrics) RecordJourneyRejected(context.Context) {
	m.rejected++
}

func (*journeyMetrics) RecordJourneyLedgerFailure(context.Context) {}

func (s journeyService) Intake(ctx context.Context, input journeys.IntakeInput) (journeys.IntakeResult, error) {
	return s.intake(ctx, input)
}

func (s journeyService) Get(ctx context.Context, journeyID utilities.ID) (journeys.Ledger, error) {
	return s.get(ctx, journeyID)
}

func TestJourneyEventIntakeRequiresAuthentication(t *testing.T) {
	handler := httpapi.NewRouter(httpapi.Options{Authentication: authenticationService{}})
	request := httptest.NewRequest(http.MethodPost, "/v1/telemetry/journey-events", bytes.NewBufferString(`{"events":[]}`))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
}

func TestJourneyEventIntakeAcceptsValidMeetingBearer(t *testing.T) {
	handler := httpapi.NewRouter(httpapi.Options{
		MeetingCredentials: meetingCredentialVerifier{
			verify: func(_ context.Context, token string) error {
				if token != "meeting-access-token" {
					t.Fatalf("token = %q, want meeting access token", token)
				}
				return nil
			},
		},
		Journeys: journeyService{
			intake: func(_ context.Context, input journeys.IntakeInput) (journeys.IntakeResult, error) {
				if len(input.Events) != 0 {
					t.Fatalf("events = %#v, want empty batch", input.Events)
				}
				return journeys.IntakeResult{}, nil
			},
			get: func(context.Context, utilities.ID) (journeys.Ledger, error) {
				t.Fatal("meeting bearer must not query the journey ledger")
				return journeys.Ledger{}, nil
			},
		},
	})
	request := bearerRequestWithBody(http.MethodPost, "/v1/telemetry/journey-events", "meeting-access-token", `{"events":[]}`)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusAccepted, response.Body.String())
	}
}

func TestJourneyEventIntakeRejectsArbitraryBearer(t *testing.T) {
	handler := httpapi.NewRouter(httpapi.Options{
		Authentication: authenticationService{
			authenticateSession: func(_ context.Context, token string) (authentication.SessionUser, error) {
				if token != "arbitrary-token" {
					t.Fatalf("token = %q, want arbitrary token", token)
				}
				return authentication.SessionUser{}, authentication.ErrUnauthenticated
			},
		},
		Journeys: journeyService{
			intake: func(context.Context, journeys.IntakeInput) (journeys.IntakeResult, error) {
				t.Fatal("invalid bearer must not reach intake")
				return journeys.IntakeResult{}, nil
			},
			get: func(context.Context, utilities.ID) (journeys.Ledger, error) {
				return journeys.Ledger{}, nil
			},
		},
	})
	request := bearerRequestWithBody(http.MethodPost, "/v1/telemetry/journey-events", "arbitrary-token", `{"events":[]}`)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusUnauthorized, response.Body.String())
	}
}

func TestJourneyEventIntakeRejectsInvalidMeetingBearer(t *testing.T) {
	handler := httpapi.NewRouter(httpapi.Options{
		MeetingCredentials: meetingCredentialVerifier{
			verify: func(context.Context, string) error { return mediaplane.ErrInvalidCredential },
		},
		Journeys: journeyService{
			intake: func(context.Context, journeys.IntakeInput) (journeys.IntakeResult, error) {
				t.Fatal("invalid meeting bearer must not reach intake")
				return journeys.IntakeResult{}, nil
			},
			get: func(context.Context, utilities.ID) (journeys.Ledger, error) { return journeys.Ledger{}, nil },
		},
	})
	request := bearerRequestWithBody(http.MethodPost, "/v1/telemetry/journey-events", "invalid-meeting-token", `{"events":[]}`)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusUnauthorized, response.Body.String())
	}
}

func TestJourneyEventIntakeAcceptsBearerSessionWithMeetingVerifier(t *testing.T) {
	handler := httpapi.NewRouter(httpapi.Options{
		MeetingCredentials: meetingCredentialVerifier{
			verify: func(context.Context, string) error { return mediaplane.ErrCredentialNotApplicable },
		},
		Authentication: authenticationService{
			authenticateSession: func(_ context.Context, token string) (authentication.SessionUser, error) {
				if token != "session-token" {
					t.Fatalf("token = %q, want session token", token)
				}
				return authSessionUser(t), nil
			},
		},
		Journeys: journeyService{
			intake: func(context.Context, journeys.IntakeInput) (journeys.IntakeResult, error) {
				return journeys.IntakeResult{}, nil
			},
			get: func(context.Context, utilities.ID) (journeys.Ledger, error) { return journeys.Ledger{}, nil },
		},
	})
	request := bearerRequestWithBody(http.MethodPost, "/v1/telemetry/journey-events", "session-token", `{"events":[]}`)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusAccepted, response.Body.String())
	}
}

func TestJourneyEventIntakeMapsMeetingVerifierFailureSafely(t *testing.T) {
	handler := httpapi.NewRouter(httpapi.Options{
		MeetingCredentials: meetingCredentialVerifier{
			verify: func(context.Context, string) error { return mediaplane.ErrPlaneUnavailable },
		},
		Journeys: journeyService{
			intake: func(context.Context, journeys.IntakeInput) (journeys.IntakeResult, error) {
				t.Fatal("verifier failure must not reach intake")
				return journeys.IntakeResult{}, nil
			},
			get: func(context.Context, utilities.ID) (journeys.Ledger, error) { return journeys.Ledger{}, nil },
		},
	})
	request := bearerRequestWithBody(http.MethodPost, "/v1/telemetry/journey-events", "meeting-access-token", `{"events":[]}`)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusServiceUnavailable, response.Body.String())
	}
}

func TestJourneyEventIntakeAcceptsAuthenticatedSessionCookie(t *testing.T) {
	handler := httpapi.NewRouter(httpapi.Options{
		Authentication: authenticationService{
			authenticateSession: func(_ context.Context, token string) (authentication.SessionUser, error) {
				if token != "session-token" {
					t.Fatalf("token = %q, want session token", token)
				}
				return authSessionUser(t), nil
			},
		},
		Journeys: journeyService{
			intake: func(context.Context, journeys.IntakeInput) (journeys.IntakeResult, error) {
				return journeys.IntakeResult{}, nil
			},
			get: func(context.Context, utilities.ID) (journeys.Ledger, error) {
				return journeys.Ledger{}, nil
			},
		},
	})
	request := httptest.NewRequest(http.MethodPost, "/v1/telemetry/journey-events", bytes.NewBufferString(`{"events":[]}`))
	request.AddCookie(&http.Cookie{Name: "chalk_session", Value: "session-token"})
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusAccepted, response.Body.String())
	}
}

func TestJourneyEventIntakeRateLimitDoesNotExhaustAuthenticatedWrites(t *testing.T) {
	limiter := &singleRequestLimiter{}
	handler := httpapi.NewRouter(httpapi.Options{
		RateLimit: httpapi.RateLimitOptions{
			Limiter: limiter,
			Now:     func() time.Time { return time.Date(2026, 7, 11, 12, 0, 0, 0, time.UTC) },
		},
		Authentication: authenticationService{
			authenticateSession: func(context.Context, string) (authentication.SessionUser, error) {
				return authSessionUser(t), nil
			},
		},
		Journeys: journeyService{
			intake: func(context.Context, journeys.IntakeInput) (journeys.IntakeResult, error) {
				return journeys.IntakeResult{}, nil
			},
			get: func(context.Context, utilities.ID) (journeys.Ledger, error) { return journeys.Ledger{}, nil },
		},
		Tenants: tenantService{
			createTenant: func(_ context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error) {
				return tenants.Tenant{ID: mustJourneyID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), Name: input.Name}, nil
			},
		},
	})

	telemetry := bearerRequestWithBody(http.MethodPost, "/v1/telemetry/journey-events", "session-token", `{"events":[]}`)
	telemetryResponse := httptest.NewRecorder()
	handler.ServeHTTP(telemetryResponse, telemetry)
	if telemetryResponse.Code != http.StatusAccepted {
		t.Fatalf("telemetry status = %d, want %d: %s", telemetryResponse.Code, http.StatusAccepted, telemetryResponse.Body.String())
	}
	if limit := telemetryResponse.Header().Get("X-RateLimit-Limit"); limit != "600" {
		t.Fatalf("telemetry rate limit = %q, want 600", limit)
	}

	write := bearerRequestWithBody(http.MethodPost, "/v1/tenants", "session-token", `{"name":"Acme"}`)
	writeResponse := httptest.NewRecorder()
	handler.ServeHTTP(writeResponse, write)
	if writeResponse.Code != http.StatusCreated {
		t.Fatalf("tenant write status = %d, want %d: %s", writeResponse.Code, http.StatusCreated, writeResponse.Body.String())
	}
}

func TestJourneyEventIntakeAcknowledgesDuplicateEventID(t *testing.T) {
	journeyID := mustJourneyID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	eventID := mustJourneyID(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	service := journeyService{
		intake: func(_ context.Context, input journeys.IntakeInput) (journeys.IntakeResult, error) {
			if len(input.Events) != 2 || input.Events[0].EventID != eventID || input.Events[1].EventID != eventID {
				t.Fatalf("events = %#v", input.Events)
			}
			return journeys.IntakeResult{AcceptedCount: 1, DuplicateCount: 1, JourneyIDs: []utilities.ID{journeyID}}, nil
		},
		get: func(context.Context, utilities.ID) (journeys.Ledger, error) { return journeys.Ledger{}, nil },
	}
	handler := httpapi.NewRouter(httpapi.Options{
		LocalSystemToken: "local-system-token",
		Journeys:         service,
	})
	body := []byte(`{"events":[` + journeyEventJSON(eventID, journeyID, 1, "in_progress") + `,` + journeyEventJSON(eventID, journeyID, 1, "in_progress") + `]}`)
	request := httptest.NewRequest(http.MethodPost, "/v1/telemetry/journey-events", bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer local-system-token")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusAccepted, response.Body.String())
	}
	if response.Header().Get("x-chalk-journey-id") != journeyID.String() {
		t.Fatalf("journey header = %q", response.Header().Get("x-chalk-journey-id"))
	}
	var payload struct {
		AcceptedCount  int      `json:"accepted_count"`
		DuplicateCount int      `json:"duplicate_count"`
		JourneyIDs     []string `json:"journey_ids"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.AcceptedCount != 1 || payload.DuplicateCount != 1 || len(payload.JourneyIDs) != 1 || payload.JourneyIDs[0] != journeyID.String() {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestJourneyEventIntakeCountsDecoderRejections(t *testing.T) {
	journeyID := mustJourneyID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	eventID := mustJourneyID(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	tests := []struct {
		name string
		body string
	}{
		{name: "malformed JSON", body: `{"events":[`},
		{name: "invalid event identifier", body: `{"events":[` + strings.Replace(journeyEventJSON(eventID, journeyID, 1, "in_progress"), eventID.String(), "not-a-uuid", 1) + `]}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			metrics := &journeyMetrics{}
			handler := httpapi.NewRouter(httpapi.Options{
				LocalSystemToken: "local-system-token",
				JourneyMetrics:   metrics,
				Journeys: journeyService{
					intake: func(context.Context, journeys.IntakeInput) (journeys.IntakeResult, error) {
						t.Fatal("intake must not run for a decoder rejection")
						return journeys.IntakeResult{}, nil
					},
					get: func(context.Context, utilities.ID) (journeys.Ledger, error) { return journeys.Ledger{}, nil },
				},
			})
			request := httptest.NewRequest(http.MethodPost, "/v1/telemetry/journey-events", bytes.NewBufferString(test.body))
			request.Header.Set("Authorization", "Bearer local-system-token")
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)

			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusBadRequest, response.Body.String())
			}
			if metrics.rejected != 1 {
				t.Fatalf("rejected = %d, want 1", metrics.rejected)
			}
		})
	}
}

func TestJourneyEventIntakeReportsUnavailableLedger(t *testing.T) {
	journeyID := mustJourneyID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	eventID := mustJourneyID(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	handler := httpapi.NewRouter(httpapi.Options{
		LocalSystemToken: "local-system-token",
		Journeys:         journeys.NewService(nil),
	})
	body := []byte(`{"events":[` + journeyEventJSON(eventID, journeyID, 1, "in_progress") + `]}`)
	request := httptest.NewRequest(http.MethodPost, "/v1/telemetry/journey-events", bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer local-system-token")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusServiceUnavailable, response.Body.String())
	}
	if !bytes.Contains(response.Body.Bytes(), []byte(`"journey_ledger_unavailable"`)) {
		t.Fatalf("response = %s", response.Body.String())
	}
}

func TestLocalJourneyLedgerRequiresSystemPrincipal(t *testing.T) {
	journeyID := mustJourneyID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	handler := httpapi.NewRouter(httpapi.Options{
		LocalTelemetry: true,
		Authentication: authenticationService{
			authenticateSession: func(context.Context, string) (authentication.SessionUser, error) {
				return authentication.SessionUser{Session: authentication.Session{
					ID:     mustJourneyID(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
					UserID: mustJourneyID(t, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
				}}, nil
			},
		},
		Journeys: journeyService{
			intake: func(context.Context, journeys.IntakeInput) (journeys.IntakeResult, error) {
				return journeys.IntakeResult{}, nil
			},
			get: func(context.Context, utilities.ID) (journeys.Ledger, error) { return journeys.Ledger{}, nil },
		},
	})
	request := httptest.NewRequest(http.MethodGet, "/v1/telemetry/journeys/"+journeyID.String(), nil)
	request.Header.Set("Authorization", "Bearer user-token")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func TestLocalJourneyLedgerReturnsTerminalState(t *testing.T) {
	journeyID := mustJourneyID(t, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	terminal := "completed"
	handler := httpapi.NewRouter(httpapi.Options{
		LocalSystemToken: "local-system-token",
		LocalTelemetry:   true,
		Journeys: journeyService{
			intake: func(context.Context, journeys.IntakeInput) (journeys.IntakeResult, error) {
				return journeys.IntakeResult{}, nil
			},
			get: func(_ context.Context, got utilities.ID) (journeys.Ledger, error) {
				if got != journeyID {
					t.Fatalf("get journey = %s", got.String())
				}
				return journeys.Ledger{
					JourneyID:     journeyID,
					TerminalState: &terminal,
					Events: []journeys.Event{{
						EventID:            mustJourneyID(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
						JourneyID:          journeyID,
						Sequence:           2,
						OccurredAt:         time.Date(2026, 7, 11, 12, 0, 0, 0, time.UTC),
						ReceivedAt:         time.Date(2026, 7, 11, 12, 0, 1, 0, time.UTC),
						Name:               "journey.terminal",
						Phase:              "terminal",
						State:              terminal,
						OriginKind:         "client",
						FirstObservedLayer: "client",
						UpstreamVisibility: "visible",
						Attributes:         json.RawMessage(`{"reason":"complete"}`),
					}},
				}, nil
			},
		},
	})
	request := httptest.NewRequest(http.MethodGet, "/v1/telemetry/journeys/"+journeyID.String(), nil)
	request.Header.Set("Authorization", "Bearer local-system-token")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	var payload struct {
		TerminalState *string `json:"terminal_state"`
		Events        []struct {
			State string `json:"state"`
		} `json:"events"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.TerminalState == nil || *payload.TerminalState != terminal || len(payload.Events) != 1 || payload.Events[0].State != terminal {
		t.Fatalf("payload = %#v", payload)
	}
}

func journeyEventJSON(eventID utilities.ID, journeyID utilities.ID, sequence int64, state string) string {
	return `{"event_id":"` + eventID.String() + `","journey_id":"` + journeyID.String() + `","sequence":` + strconv.FormatInt(sequence, 10) + `,"occurred_at":"2026-07-11T12:00:00Z","name":"journey.phase","phase":"signaling","state":"` + state + `","origin_kind":"client","first_observed_layer":"client","upstream_visibility":"visible","attributes":{"retry":true}}`
}

func mustJourneyID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}
