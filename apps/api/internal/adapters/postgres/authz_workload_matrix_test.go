package postgres

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/apitest"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var globalClaimReasons = map[string]string{
	"POST /internal/v1/transcription/jobs/claim":     "Allocates one chunk job from the global queue; identity comes from the assigned lease.",
	"POST /internal/v1/transcription/cleanup/claim":  "Allocates one cleanup job from the global queue; identity comes from the assigned lease.",
	"POST /internal/v1/transcription/finalize/claim": "Allocates one finalizer job from the global queue; identity comes from the assigned lease.",
}

func TestWorkloadAuthorizationRouteMatrix(t *testing.T) {
	matrix, err := apitest.RouteMatrix()
	if err != nil {
		t.Fatal(err)
	}
	for route, row := range matrix {
		if !strings.HasPrefix(route, "POST /internal/") {
			continue
		}
		t.Run(route, func(t *testing.T) {
			if len(row.Credentials) != 1 || row.Credentials[0].Class != "workload HMAC" || row.Credentials[0].Wrong != 401 {
				t.Fatal("worker row must explicitly require workload HMAC with 401 denials")
			}
			claim := globalClaimReasons[route] != ""
			if claim != (row.IsolationReason != "") || (!claim && row.Credentials[0].Foreign != 409) {
				t.Fatal("only named global claim routes may omit a foreign-lease denial")
			}
			kind, state := "transcription_chunk", "transcribing"
			if strings.Contains(route, "/finalize/") || strings.Contains(route, "/cleanup/") {
				kind, state = "transcription_finalize", "verifying"
			}
			ctx, tx, repository, transcriptID, jobID := newTranscriptClaimFixture(t, kind, state, false)
			if strings.Contains(route, "/cleanup/") {
				jobID = seedMatrixCleanupJob(t, tx, transcriptID)
			}
			options := httpapi.Options{}
			matrixMountWorkers(&options, transcripts.NewArtifactService(repository, repository))
			router := httpapi.NewRouter(options)
			if !matrixMountedRoutes(t, router)[route] {
				t.Fatal("matrix worker route is not actually mounted")
			}
			_, path, _ := strings.Cut(route, " ")
			body := matrixWorkerBody(route, jobID)
			request := func() *http.Request { return httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)) }
			assertMatrixDenial(t, router, request(), 401, []string{jobID.String(), transcriptID.String()})
			wrong := request()
			matrixSignWorkload(t, wrong, body, "wrong-role")
			assertMatrixDenial(t, router, wrong, 401, []string{jobID.String(), transcriptID.String()})
			if claim {
				if strings.Contains(route, "/jobs/") {
					seedMatrixChunkSource(t, tx, transcriptID, jobID)
				} else if strings.Contains(route, "/finalize/") {
					seedClaimableTranscriptChunk(t, ctx, tx, transcriptID)
				}
				otherJob := seedMatrixOtherJob(t, tx, jobID, strings.Contains(route, "/cleanup/"))
				response := httptest.NewRecorder()
				valid := request()
				matrixSignWorkload(t, valid, body, "transcription-dispatcher")
				router.ServeHTTP(response, valid)
				if response.Code != http.StatusOK {
					t.Fatalf("claim status %d: %s", response.Code, response.Body.String())
				}
				var result struct {
					Assignments []struct {
						JobID string `json:"job_id"`
					} `json:"assignments"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
					t.Fatal(err)
				}
				if len(result.Assignments) != 1 || result.Assignments[0].JobID != jobID.String() || strings.Contains(response.Body.String(), otherJob.String()) {
					t.Fatalf("claim must expose only its assigned job, not another job: %s", response.Body.String())
				}
				return
			}
			foreign := request()
			matrixSignWorkload(t, foreign, body, "transcription-dispatcher")
			assertMatrixDenial(t, router, foreign, row.Credentials[0].Foreign, []string{jobID.String(), transcriptID.String(), "claims/", "matrix-private"})
		})
	}
}

func matrixMountWorkers(options *httpapi.Options, service transcripts.Service) {
	authority := matrixWorkerAuthority{}
	options.TranscriptWorker, options.CleanupWorker, options.FinalizerWorker = service, service, service
	options.WorkloadAuthorizer = httpapi.NewHMACWorkloadAuthorizer(httpapi.HMACWorkloadAuthorizerConfig{
		Secret: []byte("matrix-workload-test-secret"), Environment: "matrix", ReleaseID: "matrix", Audience: "matrix", Nonces: &matrixNonces{seen: make(map[string]bool)},
	})
	options.ChunkAuthority, options.ManifestAuthority, options.ResultAuthority = authority, authority, authority
	options.CleanupDeleteAuthority, options.FinalizerAuthority = authority, authority
}

type matrixNonces struct{ seen map[string]bool }

func (n *matrixNonces) Consume(_ context.Context, nonce string, _ time.Duration) (bool, error) {
	if n.seen[nonce] {
		return false, nil
	}
	n.seen[nonce] = true
	return true, nil
}

func matrixSignWorkload(t *testing.T, request *http.Request, body, role string) {
	digest := sha256.Sum256([]byte(body))
	checksum := hex.EncodeToString(digest[:])
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	nonce := accountTenantIntegrationID(t).String()
	for key, value := range map[string]string{
		"X-Chalk-Workload-Timestamp": timestamp, "X-Chalk-Workload-Nonce": nonce,
		"X-Chalk-Workload-Body-SHA256": checksum, "X-Chalk-Workload-Environment": "matrix",
		"X-Chalk-Workload-Release": "matrix", "X-Chalk-Workload-Role": role, "X-Chalk-Workload-Audience": "matrix",
	} {
		request.Header.Set(key, value)
	}
	canonical := strings.Join([]string{request.Method, request.URL.EscapedPath(), checksum, timestamp, nonce, "matrix", "matrix", role, "", "", "", "matrix"}, "\n")
	mac := hmac.New(sha256.New, []byte("matrix-workload-test-secret"))
	_, _ = mac.Write([]byte(canonical))
	request.Header.Set("Authorization", "Chalk-Workload-HMAC "+base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
}

func matrixWorkerBody(route string, jobID utilities.ID) string {
	if globalClaimReasons[route] != "" {
		return `{"batch_size":1}`
	}
	body := fmt.Sprintf(`"job_id":%q,"attempt":1,"lease_token":"matrix-stale-foreign-lease"`, jobID.String())
	if strings.HasSuffix(route, "/complete") && !strings.Contains(route, "/cleanup/") {
		body += `,"result_sha256":"` + strings.Repeat("00", 32) + `","result_size_bytes":1,"content_type":"application/json"`
	}
	return "{" + body + "}"
}

// URL signing is the external object-store boundary. Include the requested job
// and object key so response assertions catch accidental cross-job signing.
type matrixWorkerAuthority struct {
	httpapi.ResultAuthority
	httpapi.CleanupDeleteAuthority
	httpapi.FinalizerAuthority
}

func matrixObjectURL(job utilities.ID, key string) string {
	return "https://objects.invalid/" + job.String() + "/" + url.PathEscape(key)
}
func (matrixWorkerAuthority) CreateChunkGETURL(_ context.Context, input httpapi.ChunkURLInput) (string, error) {
	return matrixObjectURL(input.JobID, input.Key), nil
}
func (matrixWorkerAuthority) CreateManifestGETURL(_ context.Context, input httpapi.ManifestURLInput) (string, error) {
	return matrixObjectURL(input.JobID, input.Key), nil
}
func (matrixWorkerAuthority) CreateResultPUTURL(_ context.Context, input httpapi.ResultURLInput) (string, error) {
	return matrixObjectURL(input.JobID, input.Key), nil
}
func (matrixWorkerAuthority) CreateDeleteURL(_ context.Context, input httpapi.CleanupDeleteURLInput) (string, error) {
	return matrixObjectURL(input.JobID, input.Key), nil
}
func (matrixWorkerAuthority) CreateResultGETURL(_ context.Context, input httpapi.FinalizerChunkGETURLInput) (string, error) {
	return matrixObjectURL(input.JobID, input.Key), nil
}
func (matrixWorkerAuthority) CreateFinalArtifactPUTURL(_ context.Context, input httpapi.FinalizerPUTURLInput) (string, error) {
	return matrixObjectURL(input.JobID, input.Key), nil
}

func seedMatrixCleanupJob(t *testing.T, tx pgx.Tx, transcriptID utilities.ID) utilities.ID {
	t.Helper()
	id := accountTenantIntegrationID(t)
	mustExec(t, tx, `insert into transcription_cleanup_jobs(id,tenant_id,recording_id,transcript_id,object_key,object_kind,due_at,state,attempt_count,attempt_limit) select $1,tenant_id,recording_id,id,$2,'temp_result','2000-01-01','pending',0,4 from transcriptions where id=$3`, uuid(id), "matrix-private-cleanup-"+id.String(), uuid(transcriptID))
	return id
}

func seedMatrixOtherJob(t *testing.T, tx pgx.Tx, jobID utilities.ID, cleanup bool) utilities.ID {
	t.Helper()
	id := accountTenantIntegrationID(t)
	if cleanup {
		mustExec(t, tx, `insert into transcription_cleanup_jobs(id,tenant_id,recording_id,transcript_id,object_key,object_kind,due_at,state,attempt_count,attempt_limit) select $1,tenant_id,recording_id,transcript_id,$2,object_kind,'2001-01-01','pending',0,4 from transcription_cleanup_jobs where id=$3`, uuid(id), "matrix-other-private-object-"+id.String(), uuid(jobID))
	} else {
		mustExec(t, tx, `update artifact_jobs set priority=1000000 where id=$1`, uuid(jobID))
		mustExec(t, tx, `insert into artifact_jobs(id,idempotency_key,tenant_id,episode_id,recording_id,transcript_id,chunk_id,artifact_kind,payload_schema_version,state,available_at,attempt_count,attempt_limit,priority) select $1,$2,tenant_id,episode_id,recording_id,transcript_id,chunk_id,artifact_kind,1,'pending',available_at,0,4,999999 from artifact_jobs where id=$3`, uuid(id), "matrix-other-private-job-"+id.String(), uuid(jobID))
	}
	return id
}

func seedMatrixChunkSource(t *testing.T, tx pgx.Tx, transcriptID, jobID utilities.ID) {
	t.Helper()
	chunkID := accountTenantIntegrationID(t)
	mustExec(t, tx, `insert into recording_transcription_sources(recording_id,tenant_id,manifest_key,manifest_sha256,manifest_size,manifest_content_type,schema_version,committed_at,generation,commit_digest,status,expires_at,lease_transcript_id,lease_expires_at) select recording_id,tenant_id,$2,decode(repeat('00',32),'hex'),1,'application/json',1,now(),1,decode(repeat('00',32),'hex'),'leased',now()+interval '1 hour',id,now()+interval '30 minutes' from transcriptions where id=$1`, uuid(transcriptID), "matrix-manifest-"+jobID.String())
	mustExec(t, tx, `insert into recording_transcription_source_chunks(id,recording_id,tenant_id,chunk_index,generation,start_ms,end_ms,source_start_ms,source_end_ms,identity_kind,track_class,storage_key,checksum,size,content_type) select $1,recording_id,tenant_id,0,1,0,1000,0,1000,'unknown','microphone',$2,decode(repeat('00',32),'hex'),1,'audio/flac' from transcriptions where id=$3`, uuid(chunkID), "matrix-source-"+jobID.String(), uuid(transcriptID))
	mustExec(t, tx, `update artifact_jobs set chunk_id=$1 where id=$2`, uuid(chunkID), uuid(jobID))
	mustExec(t, tx, `update transcriptions set source_manifest_key=$1,source_expires_at=now()+interval '30 minutes' where id=$2`, "matrix-manifest-"+jobID.String(), uuid(transcriptID))
}
