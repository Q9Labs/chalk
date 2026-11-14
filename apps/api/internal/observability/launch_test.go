package observability

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// fixtureCredential has a header with no type and no key ID, as the SDK test and proof fixtures send.
func fixtureCredential() string {
	encode := func(value string) string { return base64.RawURLEncoding.EncodeToString([]byte(value)) }
	return encode(`{"alg":"EdDSA"}`) + "." + encode(`{"aud":"chalk-media"}`) + ".fixture"
}

func TestParticipantMediaRejectionNamesItsRoute(t *testing.T) {
	ctx := context.Background()
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	previous := otel.GetMeterProvider()
	otel.SetMeterProvider(provider)
	t.Cleanup(func() {
		otel.SetMeterProvider(previous)
		if err := provider.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	publicKey, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{Issuer: "chalk", VerificationKeys: map[string]ed25519.PublicKey{"key": publicKey}})
	if err != nil {
		t.Fatal(err)
	}
	instrumented := InstrumentParticipantMediaVerifier(verifier, NewLaunchTelemetry(slog.New(slog.NewTextHandler(io.Discard, nil))))

	router := chi.NewRouter()
	router.Post("/v1/tenants/{tenant_id}/connection-reports", func(w http.ResponseWriter, r *http.Request) {
		if _, err := instrumented.Verify(r.Context(), fixtureCredential()); err == nil {
			t.Error("fixture credential was accepted")
		}
		w.WriteHeader(http.StatusUnauthorized)
	})
	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/v1/tenants/tenant-1/connection-reports", nil))
	if _, err := instrumented.Verify(ctx, fixtureCredential()); err == nil {
		t.Fatal("fixture credential was accepted outside a route")
	}

	var metrics metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &metrics); err != nil {
		t.Fatal(err)
	}
	got := map[string]int64{}
	for _, scope := range metrics.ScopeMetrics {
		for _, metric := range scope.Metrics {
			if metric.Name != "chalk.api.participant_media.authentication" {
				continue
			}
			for _, point := range metric.Data.(metricdata.Sum[int64]).DataPoints {
				if point.Attributes.Len() != 3 {
					t.Fatalf("tags = %v, want only outcome, reason and route", point.Attributes)
				}
				outcome, _ := point.Attributes.Value("outcome")
				reason, _ := point.Attributes.Value("reason")
				route, _ := point.Attributes.Value("route")
				got[outcome.AsString()+" "+reason.AsString()+" "+route.AsString()] += point.Value
			}
		}
	}
	want := map[string]int64{
		"rejected invalid_header /v1/tenants/{tenant_id}/connection-reports": 1,
		"rejected invalid_header unmatched":                                  1,
	}
	if len(got) != len(want) {
		t.Fatalf("points = %v, want %v", got, want)
	}
	for key, count := range want {
		if got[key] != count {
			t.Fatalf("points = %v, want %v", got, want)
		}
	}
}
