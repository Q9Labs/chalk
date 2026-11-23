package observability

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

func TestEveryRequestIsCountedByRouteAndStatusClassWhateverTheLogKeeps(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	previous := otel.GetMeterProvider()
	otel.SetMeterProvider(provider)
	t.Cleanup(func() { otel.SetMeterProvider(previous); _ = provider.Shutdown(context.Background()) })

	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	router := chi.NewRouter()
	router.Post("/v1/signal/{id}", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("fail") != "" {
			w.WriteHeader(http.StatusBadRequest)
		}
	})
	handler := RequestMiddleware(logger, RequestLogConfig{Mode: RequestLogOff})(router)
	for _, target := range []string{"/v1/signal/a", "/v1/signal/b", "/v1/signal/c?fail=1", "/nowhere"} {
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, target, nil))
	}

	var collected metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &collected); err != nil {
		t.Fatal(err)
	}
	counts := map[string]int64{}
	for _, scope := range collected.ScopeMetrics {
		for _, m := range scope.Metrics {
			sum, ok := m.Data.(metricdata.Sum[int64])
			if m.Name != "chalk.api.http.requests" || !ok {
				continue
			}
			for _, point := range sum.DataPoints {
				route, _ := point.Attributes.Value("route")
				class, _ := point.Attributes.Value("status_class")
				counts[route.AsString()+" "+class.AsString()] += point.Value
			}
		}
	}
	want := map[string]int64{"/v1/signal/{id} 2xx": 2, "/v1/signal/{id} 4xx": 1, "unmatched 4xx": 1}
	for key, value := range want {
		if counts[key] != value {
			t.Errorf("count[%q] = %d, want %d (all: %v)", key, counts[key], value, counts)
		}
	}
}
