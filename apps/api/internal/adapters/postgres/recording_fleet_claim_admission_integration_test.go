package postgres_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleetauthority"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestFleetClaimAdmissionHTTPResponse(t *testing.T) {
	for _, role := range []workeridentity.Role{workeridentity.RoleCapture, workeridentity.RoleRender} {
		t.Run(string(role), func(t *testing.T) {
			for _, test := range []struct {
				name, update string
				status       int
			}{
				{"draining", "state='draining',ready=false,admission_open=false,ready_capacity=0", http.StatusLocked},
				{"closed", "admission_open=false", http.StatusLocked},
				{"revoked", "state='revoked',ready=false,admission_open=false,ready_capacity=0", http.StatusUnauthorized},
				{"missing", "", http.StatusUnauthorized},
				{"wrong-role", "role=case when role='capture' then 'render' else 'capture' end", http.StatusUnauthorized},
				{"not-ready", "ready=false", http.StatusUnauthorized},
				{"zero-capacity", "ready_capacity=0", http.StatusUnauthorized},
				{"stale", "observed_at=clock_timestamp()-interval '3 minutes'", http.StatusUnauthorized},
			} {
				t.Run(test.name, func(t *testing.T) {
					tx, _ := newAllocationCleanupFixture(t, true, string(role))
					defer func() { _ = tx.Rollback(context.Background()) }()
					config := fleetRecoveryConfig(role)
					workerID, err := utilities.NewID()
					if err != nil {
						t.Fatal(err)
					}
					identity := recorderfleet.NodeIdentity{ProviderID: "claim-admission", WorkerID: workerID.String(), Role: role, BootGeneration: 1}
					repository := postgres.NewRecordingFleetAuthorityRepository(sqlc.New(tx))
					request := recorderfleet.BootstrapRequest{Key: config.Key, ProviderID: identity.ProviderID, NodeName: identity.ProviderID, Region: "sgp1", ReleaseID: config.Release.ReleaseID, ImageDigest: config.Release.ImageDigest, BootGeneration: 1, InventoryDigest: strings.Repeat("b", 64)}
					if _, err := repository.ReserveBootstrap(t.Context(), request); err != nil {
						t.Fatal(err)
					}
					if _, err := repository.ActivateBootstrap(t.Context(), request, identity); err != nil {
						t.Fatal(err)
					}
					execCleanupFixture(t, tx, `update recording_fleet_nodes set ready=true,admission_open=true,ready_capacity=1,observed_at=clock_timestamp() where provider_id=$1`, identity.ProviderID)
					if test.update == "" {
						execCleanupFixture(t, tx, `delete from recording_fleet_nodes where provider_id=$1`, identity.ProviderID)
					} else {
						execCleanupFixture(t, tx, `update recording_fleet_nodes set `+test.update+` where provider_id=$1`, identity.ProviderID)
					}
					service, err := recorderfleetauthority.NewService(config.Key.Environment, repository, &fleetRecoveryIssuer{})
					if err != nil {
						t.Fatal(err)
					}
					verifier, err := recorderfleetauthority.NewBoundWorkerVerifier(claimAdmissionVerifier{identity: workeridentity.Identity{WorkerID: workerID, Role: role}}, service)
					if err != nil {
						t.Fatal(err)
					}
					router := httpapi.NewRecorderWorkerRouter(recordingpipeline.Service{}, verifier)
					response := httptest.NewRecorder()
					router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/internal/v1/recorder/jobs/claim", strings.NewReader(`{}`)))
					if response.Code != test.status {
						t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
					}
					code := "worker.unauthorized"
					if test.status == http.StatusLocked {
						code = "worker.admission_closed"
					}
					if !strings.Contains(response.Body.String(), code) {
						t.Fatalf("missing code %q: %s", code, response.Body.String())
					}
				})
			}
		})
	}
}

type claimAdmissionVerifier struct{ identity workeridentity.Identity }

func (v claimAdmissionVerifier) Verify(*http.Request) (workeridentity.Identity, error) {
	return v.identity, nil
}
