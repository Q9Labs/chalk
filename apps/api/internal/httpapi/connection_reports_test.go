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
				Event    string `json:"event"`
				Provider string `json:"provider"`
				Trigger  string `json:"trigger"`
				Level    string `json:"level"`
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
			if line.Provider != provider || line.Trigger != "audio_receive_stuck" || line.Level != "WARN" {
				t.Fatalf("connection report log = %+v, want provider %q, trigger audio_receive_stuck, level WARN\n%s", line, provider, logs.String())
			}
		})
	}
}
