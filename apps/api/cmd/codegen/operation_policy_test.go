package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
)

// Run both emitters: the public contract and the shipped SDK metadata must
// retain ordered caller/resource quotas without breaking single-quota readers.
func TestOperationPolicyQuotasSurviveGeneration(t *testing.T) {
	primary := ratelimit.Policy{Name: "problem_reports.participant", Limit: 3, Window: time.Hour}
	shared := ratelimit.Policy{Name: "problem_reports.episode", Limit: 20, Window: time.Hour}
	route := httpapi.Post[struct{}, struct{}]("/quota-fixture", "/quota-fixture", "sendProblemReport", nil, nil).
		RateLimit(primary).SharedRateLimits(shared).RouteContract()
	gen := newGenerator([]httpapi.APIRouteContract{route})
	gen.addRoute(route)
	operation := gen.doc.Paths[route.Path]["post"].(map[string]any)
	want := []map[string]any{rateLimitContract(primary), rateLimitContract(shared)}
	if !reflect.DeepEqual(operation["x-chalk-rate-limits"], want) || !reflect.DeepEqual(operation["x-chalk-rate-limit"], want[0]) {
		t.Fatalf("OpenAPI lost ordered quotas or primary compatibility: %v", operation)
	}
	directory := t.TempDir()
	input, output := filepath.Join(directory, "openapi.json"), filepath.Join(directory, "schemas.ts")
	raw, err := json.Marshal(gen.doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(input, raw, 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("node", "../../../../tools/contract-fixture-proof/src/emitters/effect-schemas.mjs")
	command.Env = append(os.Environ(), "CODEGEN_OPENAPI_PATH="+input, "CODEGEN_EFFECT_OUTPUT_PATH="+output)
	if raw, err := command.CombinedOutput(); err != nil {
		t.Fatalf("SDK emitter: %v\n%s", err, raw)
	}
	generated, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	var policy struct {
		RateLimit struct {
			Limit         int
			Policy        string
			WindowSeconds int
		}
		RateLimits []struct {
			Limit         int
			Policy        string
			WindowSeconds int
		}
	}
	for _, line := range strings.Split(string(generated), "\n") {
		if body, ok := strings.CutPrefix(strings.TrimSpace(line), `"sendProblemReport": `); ok {
			if err := json.Unmarshal([]byte(strings.TrimSuffix(body, ",")), &policy); err != nil {
				t.Fatal(err)
			}
		}
	}
	if len(policy.RateLimits) != 2 || policy.RateLimits[0].Limit != 3 || policy.RateLimits[1].Limit != 20 || policy.RateLimits[0].Policy != primary.Name || policy.RateLimits[1].Policy != shared.Name || policy.RateLimits[0].WindowSeconds != 3600 || policy.RateLimits[1].WindowSeconds != 3600 || policy.RateLimit != policy.RateLimits[0] {
		t.Fatalf("SDK lost quota order, values, or primary compatibility: %+v", policy)
	}
}
