package httpapi

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/observability"
)

// A join_failed or audio_receive_stuck page has to say which provider failed. The
// provider comes from the verified media credential, never from the report body.
func TestConnectionReportLogNamesTheCredentialProvider(t *testing.T) {
	for _, provider := range []string{accessgrants.ProviderCloudflareSFU, accessgrants.ProviderChalkSFU} {
		t.Run(provider, func(t *testing.T) {
			var logs bytes.Buffer
			router := chi.NewRouter()
			router.Use(observability.RequestMiddleware(slog.New(slog.NewJSONHandler(&logs, nil))))
			router.Post("/report", func(w http.ResponseWriter, r *http.Request) {
				subject := accessgrants.Subject{Provider: provider, ConnectionID: "connection"}
				if err := logConnectionReport(r.Context(), subject, connectionReport{Version: 1, Trigger: "audio_receive_stuck"}); err != nil {
					t.Errorf("log connection report: %v", err)
				}
			})
			router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/report", nil))

			var line struct {
				Event             string `json:"event"`
				Provider          string `json:"provider"`
				Trigger           string `json:"trigger"`
				Level             string `json:"level"`
				ProviderSessionID string `json:"provider_session_id"`
				ConnectionID      string `json:"connection_id"`
			}
			for _, raw := range bytes.Split(bytes.TrimSpace(logs.Bytes()), []byte("\n")) {
				var candidate struct {
					Event string `json:"event"`
				}
				if json.Unmarshal(raw, &candidate) == nil && candidate.Event == "sdk.connection_report" {
					if err := json.Unmarshal(raw, &line); err != nil {
						t.Fatalf("decode log line %s: %v", raw, err)
					}
				}
			}
			if line.ConnectionID != "connection" {
				t.Fatalf("connection_id = %q, want the key the own SFU logs for the connection", line.ConnectionID)
			}
			if line.ProviderSessionID != "connection" {
				t.Fatalf("provider_session_id = %q, want the media connection a call_stats row carries", line.ProviderSessionID)
			}
			if line.Provider != provider || line.Trigger != "audio_receive_stuck" || line.Level != "WARN" {
				t.Fatalf("connection report log = %+v, want provider %q, trigger audio_receive_stuck, level WARN\n%s", line, provider, logs.String())
			}
		})
	}
}

func TestConnectionReportAcceptsOnlyBoundedReceiverAndAccessRetryEvents(t *testing.T) {
	cases := []struct {
		name  string
		event string
		valid bool
	}{
		{"receivers closed with bundle flag", `{"event":"receivers_closed","elapsed_ms":5,"receivers_stopped":3,"bundle_tag_held":true}`, true},
		{"access retry in a join", `{"event":"access_retry","elapsed_ms":5,"state":"joining"}`, true},
		{"receivers closed over the cap", `{"event":"receivers_closed","elapsed_ms":5,"receivers_stopped":10001}`, false},
		{"negative receivers closed", `{"event":"receivers_closed","elapsed_ms":5,"receivers_stopped":-1}`, false},
		{"receiver count on another event", `{"event":"access_retry","elapsed_ms":5,"receivers_stopped":1}`, false},
		{"bundle flag on another event", `{"event":"media_state","elapsed_ms":5,"bundle_tag_held":false}`, false},
		{"unknown event", `{"event":"receivers_dropped","elapsed_ms":5}`, false},
		{"storage block", `{"event":"chat_upload_failed","elapsed_ms":5,"upload_failure":"storage_unreachable"}`, true},
		{"storage status", `{"event":"chat_upload_failed","elapsed_ms":5,"upload_failure":"storage_rejected","http_status":403}`, true},
		{"unknown upload failure", `{"event":"chat_upload_failed","elapsed_ms":5,"upload_failure":"cors"}`, false},
		{"upload failure on another event", `{"event":"access_retry","elapsed_ms":5,"upload_failure":"initiate_failed"}`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := `{"version":1,"trigger":"connection_lost","events":[` + tc.event + `]}`
			request := httptest.NewRequest(http.MethodPost, "/v1/tenants/t/connection-reports", bytes.NewBufferString(body))
			_, err := decodeConnectionReport(request)
			if tc.valid && err != nil {
				t.Fatalf("decodeConnectionReport rejected %s: %v", tc.event, err)
			}
			if !tc.valid && err == nil {
				t.Fatalf("decodeConnectionReport accepted %s", tc.event)
			}
		})
	}
}

// A client that never binds an audio element reports bytes flowing; that is a diagnostic, not a failure.
func TestUnboundAudioReportLogsAtInfoNotAsAFailure(t *testing.T) {
	var logs bytes.Buffer
	router := chi.NewRouter()
	router.Use(observability.RequestMiddleware(slog.New(slog.NewJSONHandler(&logs, nil))))
	router.Post("/report", func(w http.ResponseWriter, r *http.Request) {
		subject := accessgrants.Subject{Provider: accessgrants.ProviderChalkSFU, ConnectionID: "connection"}
		_ = logConnectionReport(r.Context(), subject, connectionReport{Version: 1, Trigger: "audio_receive_unbound"})
	})
	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/report", nil))
	if !bytes.Contains(logs.Bytes(), []byte(`"level":"INFO"`)) || bytes.Contains(logs.Bytes(), []byte(`"level":"WARN"`)) {
		t.Fatalf("unbound audio report is not an info line: %s", logs.String())
	}
}

func TestConnectionReportAcceptsTheDiagnosisRoundEventsAndRejectsUnknownElementStates(t *testing.T) {
	cases := []struct {
		name  string
		body  string
		valid bool
	}{
		{"unbound audio", `{"version":1,"trigger":"audio_receive_unbound","events":[{"event":"audio_receive_unbound","source":"microphone","receive_state":"bytes_flowing","element":"none","duration_ms":12000}]}`, true},
		{"stuck audio with a playing element", `{"version":1,"trigger":"audio_receive_stuck","events":[{"event":"audio_receive_stuck","source":"microphone","receive_state":"track_received","element":"playing","duration_ms":12000}]}`, true},
		{"unknown element state", `{"version":1,"trigger":"audio_receive_stuck","events":[{"event":"audio_receive_stuck","source":"microphone","receive_state":"track_received","element":"muted","duration_ms":12000}]}`, false},
		{"time to ice", `{"version":1,"trigger":"audio_receive_summary","events":[{"event":"ice_connected","duration_ms":800}]}`, true},
		{"time to first audio", `{"version":1,"trigger":"audio_receive_summary","events":[{"event":"first_audio_bytes","source":"microphone","duration_ms":3000}]}`, true},
		{"video stall", `{"version":1,"trigger":"video_receive_stalled","events":[{"event":"video_receive_stalled","source":"camera","duration_ms":8000}]}`, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := decodeConnectionReport(httptest.NewRequest(http.MethodPost, "/v1/tenants/t/connection-reports", bytes.NewBufferString(tc.body)))
			if tc.valid && err != nil {
				t.Fatalf("rejected: %v", err)
			}
			if !tc.valid && err == nil {
				t.Fatal("accepted")
			}
		})
	}
}
