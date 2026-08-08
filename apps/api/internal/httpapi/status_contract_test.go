package httpapi_test

import (
	"net/http"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
)

func TestStatusRouteContractsExposeCanonicalPublicAndOpsBoundaries(t *testing.T) {
	contracts := make(map[string]httpapi.APIRouteContract)
	for _, contract := range httpapi.PreviewRouteContracts() {
		contracts[contract.OperationID] = contract
	}

	public, ok := contracts["getPublicStatus"]
	if !ok {
		t.Fatal("missing getPublicStatus contract")
	}
	if public.Method != http.MethodGet || public.Path != "/v1/status" || public.Auth != "" || public.Responses[0].Status != http.StatusOK {
		t.Fatalf("public status contract = %#v", public)
	}
	if len(public.Responses[0].Headers) != 1 || public.Responses[0].Headers[0].Name != "Cache-Control" || !public.Responses[0].Headers[0].Required {
		t.Fatalf("public status cache header contract = %#v", public.Responses[0].Headers)
	}

	ingest, ok := contracts["ingestMonitorResult"]
	if !ok {
		t.Fatal("missing ingestMonitorResult contract")
	}
	if ingest.Method != http.MethodPost || ingest.Path != "/v1/ops/ingest/monitor-results" || ingest.Auth != httpapi.APIAuthOpsToken {
		t.Fatalf("ingest contract = %#v", ingest)
	}
	if ingest.Responses[0].Status != http.StatusAccepted || ingest.BodyLimitBytes <= 0 {
		t.Fatalf("ingest response/body contract = %#v", ingest)
	}
	if ingest.RateLimit.Name != ratelimit.PolicyNameTelemetryIntake {
		t.Fatalf("ingest rate limit = %#v, want telemetry intake", ingest.RateLimit)
	}
}
