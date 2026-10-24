package recorderfleetcontrol

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestIdentityLeaseReadRequiresExplicitAuthorityAndCount(t *testing.T) {
	key := recorderfleet.PoolKey{Environment: "nightly", Role: workeridentity.RoleRender}
	identity := recorderfleet.NodeIdentity{ProviderID: "42", WorkerID: "55555555-5555-4555-8555-555555555555", Role: key.Role, BootGeneration: 3}
	for _, scenario := range []string{"valid-zero", "valid-positive", "valid-no-heartbeat", "old-api-404", "old-api-unfenced", "missing-ack", "missing-count", "null-count", "missing-timestamp", "wrong-identity", "unknown-field"} {
		t.Run(scenario, func(t *testing.T) {
			observation := map[string]any{"identity": identity, "active_leases": 0, "observed_at": time.Now().UTC(), "leases_observed_at": time.Now().UTC(), "identity_absent": true}
			switch scenario {
			case "valid-no-heartbeat":
				delete(observation, "observed_at")
			case "valid-positive":
				observation["active_leases"] = 1
			case "missing-count":
				delete(observation, "active_leases")
			case "null-count":
				observation["active_leases"] = nil
			case "missing-timestamp":
				delete(observation, "leases_observed_at")
			case "wrong-identity":
				other := identity
				other.BootGeneration++
				observation["identity"] = other
			case "unknown-field":
				observation["unrecognized_zero"] = 0
			}
			body, _ := json.Marshal(map[string]any{"schema_version": recorderfleet.CommandSchemaVersion, "environment": key.Environment, "observation": observation})
			httpClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				if request.Method != http.MethodPost || request.URL.Path != "/internal/v1/recorder/fleet/nodes/42/leases" || request.Header.Get("X-Chalk-Fleet-Identity-Leases") != "2" {
					t.Fatalf("request not fenced: %+v", request)
				}
				status := http.StatusOK
				if scenario == "old-api-404" {
					status = http.StatusNotFound
				}
				response := jsonResponse(status, string(body))
				if scenario != "missing-ack" {
					response.Header.Set("X-Chalk-Fleet-Identity-Leases", "2")
					if scenario == "old-api-unfenced" {
						response.Header.Set("X-Chalk-Fleet-Identity-Leases", "1")
					}
				}
				return response, nil
			})}
			client, err := New(Config{BaseURL: "https://control.example", HTTPClient: httpClient, Key: key})
			if err != nil {
				t.Fatal(err)
			}
			got, err := client.ObserveIdentity(context.Background(), identity)
			if strings.HasPrefix(scenario, "valid-") {
				if err != nil || got.Identity != identity || !got.IdentityAbsent || (scenario == "valid-positive" && got.ActiveLeases != 1) {
					t.Fatalf("got=%+v error=%v", got, err)
				}
			} else if err == nil {
				t.Fatalf("incomplete authority read as zero: %+v", got)
			}
		})
	}
}
