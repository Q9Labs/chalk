package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/observability"
)

const callStatsSessionID = "3f2b8c1e-9d4a-4b7e-8c55-0a1d2e3f4a5b"
const callStatsFixture = `{"version":1,"samples":[` +
	`{"elapsed_ms":10000,"window_ms":10000,"connection_type":"udp","local_candidate_type":"host","remote_candidate_type":"srflx","rtt_ms":42,"send_bitrate_kbps":850,"send_loss_pct":0.4,"send_jitter_ms":3,"send_layer":"h","recv_bitrate_kbps":1200,"recv_loss_pct":1.5,"recv_jitter_ms":6,"recv_height":360,"freeze_count":1,"freeze_ms":420},` +
	`{"elapsed_ms":20000,"window_ms":10000,"connection_type":"turn","local_candidate_type":"relay","remote_candidate_type":"host","relay_protocol":"tls"}]}`

func TestCallStatsUploadIsLoggedUnderTheSession(t *testing.T) {
	runtime, err := observability.Start(context.Background(), observability.Config{Environment: "test", Service: "call-stats-test", Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := observability.TelemetryShutdownContext()
		defer cancel()
		if err := runtime.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	}()
	var logs bytes.Buffer
	router := chi.NewRouter()
	router.Use(observability.RequestMiddleware(observability.New(observability.Config{Environment: "test", LogFormat: observability.LogFormatJSON}, &logs).Logger()))
	router.Use(observability.OTelHTTPMiddleware())
	callStatsEndpoint(&participantMediaVerifierStub{subject: participantMediaSubject(t)}).Mount(router, DefaultRateLimitOptions())
	send := func(body string, auth bool) int {
		r := httptest.NewRequest(http.MethodPost, "/tenants/11111111-1111-4111-8111-111111111111/call-stats", strings.NewReader(body))
		if auth {
			r.Header.Set("Authorization", "Bearer "+participantMediaCredential)
		}
		r.Header.Set("baggage", "session.id="+callStatsSessionID)
		r.Header.Set("CF-IPCountry", "AE")
		r.Header.Set("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, r)
		return response.Code
	}
	if got := send(callStatsFixture, false); got != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d", got)
	}
	if got := send(callStatsFixture, true); got != http.StatusNoContent {
		t.Fatalf("upload: %d", got)
	}

	var rows []map[string]any
	scanner := bufio.NewScanner(&logs)
	for scanner.Scan() {
		var line map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
			t.Fatal(err)
		}
		if line["event"] == "sdk.call_stats" {
			rows = append(rows, line)
		}
	}
	if len(rows) != 2 {
		t.Fatalf("rows=%d, want one per sample", len(rows))
	}
	first := rows[0]
	for key, want := range map[string]any{
		"session.id": callStatsSessionID, "connection_type": "udp", "rtt_ms": float64(42), "recv_loss_pct": 1.5, "recv_height": float64(360),
		"freeze_count": float64(1), "send_layer": "h", "country": "AE", "client_family": "safari", "client_os": "ios",
	} {
		if first[key] != want {
			t.Errorf("%s=%v, want %v", key, first[key], want)
		}
	}
	if rows[1]["connection_type"] != "turn" || rows[1]["relay_protocol"] != "tls" || rows[1]["session.id"] != callStatsSessionID {
		t.Errorf("relay row = %v", rows[1])
	}
	if _, present := rows[1]["rtt_ms"]; present {
		t.Error("an unreported field was logged as zero")
	}
	for _, line := range rows {
		for key := range line {
			if strings.Contains(key, "ip") && key != "participant_id_hash" {
				t.Errorf("address-like field %q in stats row", key)
			}
		}
	}
}

func TestCallStatsRejectsFreeTextAndOutOfRangeValues(t *testing.T) {
	for _, test := range []struct{ name, from, to string }{
		{"unknown type", `"connection_type":"udp"`, `"connection_type":"203.0.113.9"`},
		{"candidate text", `"remote_candidate_type":"srflx"`, `"remote_candidate_type":"candidate:1 1 udp 2113937151 192.0.2.1"`},
		{"loss above 100", `"recv_loss_pct":1.5`, `"recv_loss_pct":101`},
		{"negative rtt", `"rtt_ms":42`, `"rtt_ms":-1`},
		{"window too short", `"window_ms":10000,"connection_type":"udp"`, `"window_ms":10,"connection_type":"udp"`},
		{"unknown field", `"rtt_ms":42`, `"rtt_ms":42,"ip":"192.0.2.1"`},
		{"version", `"version":1`, `"version":2`},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := strings.Replace(callStatsFixture, test.from, test.to, 1)
			if body == callStatsFixture {
				t.Fatal("fixture was not changed")
			}
			if _, err := decodeCallStats(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))); err == nil {
				t.Fatal("accepted")
			}
		})
	}
	if _, err := decodeCallStats(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(callStatsFixture))); err != nil {
		t.Fatalf("fixture rejected: %v", err)
	}
	empty := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"version":1,"samples":[]}`))
	if _, err := decodeCallStats(empty); err == nil {
		t.Fatal("empty upload accepted")
	}
}

func TestClientFamilies(t *testing.T) {
	for agent, want := range map[string][2]string{
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0": {"edge", "windows"},
		"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36":         {"chrome", "android"},
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0":                                          {"firefox", "macos"},
		"Chalk/1 CFNetwork/1494.0.7 Darwin/23.4.0": {"native", "ios"},
		"okhttp/4.9.2": {"native", "android"},
		"":             {"other", "other"},
	} {
		if family, system := clientFamilies(agent); family != want[0] || system != want[1] {
			t.Errorf("%q = %s/%s, want %s/%s", agent, family, system, want[0], want[1])
		}
	}
}
