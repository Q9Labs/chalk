package httpapi

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/observability"
)

func decodeCallStatsBody(t *testing.T, body string) (callStats, error) {
	t.Helper()
	var logs bytes.Buffer
	var stats callStats
	var err error
	router := chi.NewRouter()
	router.Use(observability.RequestMiddleware(slog.New(slog.NewJSONHandler(&logs, nil))))
	router.Post("/stats", func(_ http.ResponseWriter, r *http.Request) { stats, err = decodeCallStats(r) })
	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/stats", strings.NewReader(body)))
	return stats, err
}

func TestCallStatsAcceptsTheFieldsThatExplainABadWindow(t *testing.T) {
	stats, err := decodeCallStatsBody(t, `{"version":1,"samples":[{"elapsed_ms":5000,"window_ms":5000,"connection_type":"udp","relay_offered":true,
		"jitter_buffer_delay_ms":200,"send_nack_count":3,"send_pli_count":1,"recv_nack_count":4,"recv_pli_count":2,"recv_frames_dropped":9,
		"available_incoming_kbps":1500,"available_outgoing_kbps":2000,"quality_limitation":"bandwidth","freeze_count":1,"freeze_ms":3000}]}`)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	attributes := stats.Samples[0].logAttributes()
	logged := map[string]any{}
	for i := 0; i+1 < len(attributes); i += 2 {
		logged[attributes[i].(string)] = attributes[i+1]
	}
	for key, want := range map[string]any{"quality_limitation": "bandwidth", "relay_offered": true, "jitter_buffer_delay_ms": int64(200), "recv_pli_count": int64(2), "available_outgoing_kbps": int64(2000), "recv_frames_dropped": int64(9)} {
		if logged[key] != want {
			t.Errorf("logged %s = %v, want %v", key, logged[key], want)
		}
	}
}

func TestCallStatsRejectsAnUnknownLimitationAndOutOfRangeCounts(t *testing.T) {
	for name, body := range map[string]string{
		"limitation":   `{"version":1,"samples":[{"elapsed_ms":1,"window_ms":5000,"connection_type":"udp","quality_limitation":"free text"}]}`,
		"count":        `{"version":1,"samples":[{"elapsed_ms":1,"window_ms":5000,"connection_type":"udp","recv_nack_count":1000001}]}`,
		"negative":     `{"version":1,"samples":[{"elapsed_ms":1,"window_ms":5000,"connection_type":"udp","jitter_buffer_delay_ms":-1}]}`,
		"unknownField": `{"version":1,"samples":[{"elapsed_ms":1,"window_ms":5000,"connection_type":"udp","candidate_address":"203.0.113.9"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeCallStatsBody(t, body); err == nil {
				t.Fatal("the sample was accepted")
			}
		})
	}
}
