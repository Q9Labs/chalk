package postgres

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
)

// Exercise the actual HTTP responses, including a mixed list containing expired
// recordings. The optional published-client proof makes live requests here too.
func TestRecordingExpiryPreservesPublishedClientStatuses(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	ctx := t.Context()
	connection, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Release()
	for _, mode := range []string{"on_demand", "automatic"} {
		t.Run(mode, func(t *testing.T) {
			tenantID := mustTenantPolicyTestID(t)
			if _, err := connection.Exec(ctx, `insert into tenants(id,name,recording_render_mode) values($1,'Published recording client fixture',$2)`, tenantID.Bytes(), mode); err != nil {
				t.Fatal(err)
			}
			defer cleanupTranscriptPolicyFixture(t, ctx, connection, tenantID)
			defer func() {
				if _, err := connection.Exec(ctx, `delete from recording_artifacts where tenant_id=$1`, tenantID.Bytes()); err != nil {
					t.Error(err)
				}
			}()
			type fixture struct {
				ID          string `json:"id"`
				Status      string `json:"status"`
				FailureCode string `json:"failure_code"`
			}
			fixtures := make([]fixture, 0, 4)
			for _, reason := range []string{"recording_source_expired", "render_deadline_exceeded", "recording_expired", ""} {
				id := insertTranscriptPolicyFixture(t, ctx, connection, tenantID, "on_demand", false)
				insertTranscriptPolicyCaptureCompleteFixture(t, ctx, connection, tenantID, id)
				item := fixture{ID: id.String(), Status: "unavailable", FailureCode: reason}
				if reason == "recording_source_expired" {
					if _, err := connection.Exec(ctx, `update recording_pipelines set capture_completed_at=now()-interval '31 days' where recording_id=$1`, id.Bytes()); err != nil {
						t.Fatal(err)
					}
				} else {
					jobID := mustTenantPolicyTestID(t)
					if _, err := connection.Exec(ctx, `insert into recording_jobs(id,tenant_id,episode_id,recording_id,kind,idempotency_key,payload_schema_version,state,attempt_limit,error_code,terminal_at,available_at) select $1,tenant_id,episode_id,id,'render','render:'||id::text,1,case when $2='render_deadline_exceeded' then 'terminal_failure' else 'succeeded' end,3,case when $2='render_deadline_exceeded' then $2 else null end,now(),now() from recordings where id=$3`, jobID.Bytes(), reason, id.Bytes()); err != nil {
						t.Fatal(err)
					}
					if reason != "render_deadline_exceeded" {
						expiry := "now()-interval '1 second'"
						if reason == "" {
							expiry = "now()+interval '1 day'"
							item.Status = "ready"
						}
						if _, err := connection.Exec(ctx, `insert into recording_artifacts(recording_id,tenant_id,render_job_id,object_key,content_type,byte_size,checksum,duration_millis,committed_at,expires_at) values($1,$2,$3,'fixture.mp4','video/mp4',1,$4,1000,now()-interval '2 days',`+expiry+`)`, id.Bytes(), tenantID.Bytes(), jobID.Bytes(), make([]byte, 32)); err != nil {
							t.Fatal(err)
						}
					}
				}
				fixtures = append(fixtures, item)
			}
			queries := sqlc.New(pool)
			const token = "published-client-fixture-system-token"
			server := httptest.NewServer(httpapi.NewRouter(httpapi.Options{
				LocalSystemToken: token,
				TenantAuthz:      authorization.NewTenantPolicy(nil, nil),
				Recordings:       recordings.NewService(NewRecordingRepository(queries)),
				RecordingExports: recordingpipeline.NewService(NewRecordingPipelineRepository(queries)),
			}))
			defer server.Close()
			for _, item := range fixtures {
				result := serviceHTTPRequest(server.Client(), http.MethodGet, server.URL+"/v1/tenants/"+tenantID.String()+"/recordings/"+item.ID, token, "")
				if result.status != http.StatusOK {
					t.Fatalf("get recording: status=%d body=%s", result.status, result.body)
				}
				var body struct {
					Export struct {
						Status         string `json:"status"`
						FailureCode    string `json:"failure_code"`
						FailureMessage string `json:"failure_message"`
					} `json:"export"`
				}
				if err := json.Unmarshal([]byte(result.body), &body); err != nil {
					t.Fatal(err)
				}
				if body.Export.Status != item.Status || body.Export.FailureCode != item.FailureCode || (item.FailureCode != "" && body.Export.FailureMessage == "") {
					t.Fatalf("recording expiry response=%s want=%+v", result.body, item)
				}
			}
			result := serviceHTTPRequest(server.Client(), http.MethodGet, server.URL+"/v1/tenants/"+tenantID.String()+"/recordings", token, "")
			var list struct {
				Recordings []json.RawMessage `json:"recordings"`
			}
			if err := json.Unmarshal([]byte(result.body), &list); err != nil || result.status != http.StatusOK || len(list.Recordings) != len(fixtures) {
				t.Fatalf("mixed recording list: status=%d body=%s err=%v", result.status, result.body, err)
			}
			if script := os.Getenv("CHALK_RECORDING_SDK_COMPAT_PROOF"); script != "" {
				encoded, err := json.Marshal(fixtures)
				if err != nil {
					t.Fatal(err)
				}
				command := exec.CommandContext(ctx, "node", script)
				command.Env = append(os.Environ(), "CHALK_COMPAT_API_URL="+server.URL, "CHALK_COMPAT_TENANT_ID="+tenantID.String(), fmt.Sprintf("CHALK_COMPAT_API_KEY=%s", token), "CHALK_COMPAT_RECORDINGS="+string(encoded))
				output, err := command.CombinedOutput()
				if err != nil {
					t.Fatalf("published clients failed: %v\n%s", err, output)
				}
				t.Logf("%s", output)
			}
		})
	}
}
