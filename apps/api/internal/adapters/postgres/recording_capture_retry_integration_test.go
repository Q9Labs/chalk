package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/recorderworker"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// The fake repeats the observed timeout/internal_error failures through the old
// five-attempt limit. Recovery on its sixth request must still be reachable.
func TestRecordingCaptureProviderOutagePostgres(t *testing.T) {
	for _, operation := range []captureplane.OperationKind{captureplane.OperationPullCaptureTracks, captureplane.OperationRenegotiateCaptureConnection} {
		for _, permanent := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/permanent=%t", operation, permanent), func(t *testing.T) {
				ctx := t.Context()
				tx, repository, identity := newCaptureRetryFixture(t)
				var calls atomic.Int32
				server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					if strings.HasSuffix(r.URL.Path, "/sessions/new") {
						_, _ = fmt.Fprint(w, `{"sessionId":"capture-connection","sessionDescription":{"type":"offer","sdp":"v=0\r\n"}}`)
						return
					}
					if operation == captureplane.OperationPullCaptureTracks && strings.HasSuffix(r.URL.Path, "/renegotiate") {
						_, _ = fmt.Fprint(w, `{}`)
						return
					}
					call := calls.Add(1)
					if permanent || call <= 5 {
						if call%2 == 1 {
							select {
							case <-r.Context().Done():
							case <-time.After(100 * time.Millisecond):
							}
							return
						}
						w.WriteHeader(http.StatusInternalServerError)
						_, _ = fmt.Fprint(w, `{"errorCode":"internal_error","errorDescription":"fixture provider outage"}`)
						return
					}
					if strings.HasSuffix(r.URL.Path, "/renegotiate") {
						_, _ = fmt.Fprint(w, `{}`)
						return
					}
					_, _ = fmt.Fprint(w, `{"sessionDescription":{"type":"answer","sdp":"v=0\r\n"},"tracks":[{"sessionId":"publisher","trackName":"audio","mid":"0","location":"remote"}]}`)
				}))
				listener, err := net.Listen("tcp", "127.0.0.1:3960")
				if err != nil {
					t.Fatal(err)
				}
				server.Listener = listener
				server.Start()
				t.Cleanup(server.Close)
				adapter, err := sfu.NewAdapterWithClient(config.CloudflareRealtimeConfig{
					RealtimeAppID: "fixture-app", RealtimeAppSecret: "fixture-secret", RequestTimeout: 20 * time.Millisecond,
				}, server.Client(), server.URL)
				if err != nil {
					t.Fatal(err)
				}
				maxWait := capturesignaling.DefaultWait
				if permanent {
					maxWait = 100 * time.Millisecond
				}
				service, err := capturesignaling.NewService(postgres.NewRecordingCaptureSignalingRepositoryWithTransactor(captureRetryTransaction{tx}, nil), captureRetryResolver{adapter}, capturesignaling.Options{MaxWait: maxWait})
				if err != nil {
					t.Fatal(err)
				}
				var state recordingpipeline.JobState
				var backoff time.Duration
				var attempts int
				for attempts = 1; attempts <= recordingpipeline.DefaultCaptureAttemptLimit; attempts++ {
					job, err := repository.Claim(ctx, recordingpipeline.ClaimInput{
						ClaimRequestID: newCaptureRetryID(t), Kind: recordingpipeline.JobKindCapture,
						Owner: "capture-retry-worker", LeaseToken: fmt.Sprintf("retry-lease-%d", attempts), LeaseFor: time.Minute,
					})
					if err != nil {
						t.Fatalf("claim attempt %d: %v", attempts, err)
					}
					if attempts == 1 {
						execCleanupFixture(t, tx, `insert into recording_bundles(id,tenant_id,recording_id,capture_job_id,sequence_number,fencing_generation,object_key,content_type,codec,byte_size,checksum,monotonic_start_millis,monotonic_end_millis,media_start_millis,media_end_millis)
							values(gen_random_uuid(),$1,$2,$3,0,1,'fixture/committed-before-outage','application/octet-stream','chalk.bundle.v1',9,decode(repeat('ab',32),'hex'),0,1000,0,1000)`, identity.TenantID.Bytes(), identity.RecordingID.Bytes(), job.ID.Bytes())
					}
					envelope := job.Authority.Envelope
					handle, err := capturesignaling.NewSignalingHandle(envelope.SignalingHandle)
					if err != nil {
						t.Fatal(err)
					}
					command := capturesignaling.Command{
						SignalingHandle: handle,
						Authority: capturesignaling.CommandAuthority{
							TenantID: identity.TenantID, SpaceID: identity.SpaceID, EpisodeID: identity.EpisodeID, RecordingID: identity.RecordingID,
							JobID: job.ID, AttemptCount: job.AttemptCount, FencingGeneration: job.FencingGeneration,
							CaptureEpoch: captureplane.CaptureEpoch(envelope.CaptureEpoch), EnvelopeDigest: job.Authority.EnvelopeDigest,
						},
						Lease:    capturesignaling.WorkerLease{Owner: *job.LeaseOwner, Token: *job.LeaseToken, ExpiresAt: *job.LeaseExpiresAt},
						Identity: capturesignaling.CommandIdentity{Operation: captureplane.OperationCreateCaptureConnection, PlanRevision: 1, IdempotencyKey: "create"},
						Input:    capturesignaling.CommandInput{CreateCaptureConnection: &captureplane.CreateCaptureConnectionInput{}},
					}
					created, err := service.Execute(ctx, capturesignaling.ExecuteRequest{Command: command})
					if err != nil {
						t.Fatalf("create: %v", err)
					}
					command.Identity.Operation = operation
					command.Identity.IdempotencyKey = "recover"
					connection := created.Result.CreateCaptureConnection.Connection.ConnectionReference
					if operation == captureplane.OperationPullCaptureTracks {
						// Pull is legal only after the initial offer has its answer.
						command.Input = capturesignaling.CommandInput{RenegotiateCaptureConnection: &captureplane.RenegotiateCaptureConnectionInput{
							Connection: connection, NegotiationID: created.Result.CreateCaptureConnection.Negotiation.ID, Description: captureplane.Description{Type: "answer", SDP: "v=0\r\n"},
						}}
						command.Identity.Operation = captureplane.OperationRenegotiateCaptureConnection
						command.Identity.IdempotencyKey = "initial-answer"
						// Initial negotiation is separate from the outage under test.
						if _, err := service.Execute(ctx, capturesignaling.ExecuteRequest{Command: command}); err != nil {
							t.Fatalf("initial negotiation: %v", err)
						}
						command.Identity.Operation = operation
						command.Identity.IdempotencyKey = "recover"
						command.Input = capturesignaling.CommandInput{PullCaptureTracks: &captureplane.PullCaptureTracksInput{
							Connection: connection, LocalDescription: &captureplane.Description{Type: "offer", SDP: "v=0\r\n"},
							Tracks: []captureplane.CaptureTrack{{OwnerReference: "publisher", TrackReference: "audio", ParticipantID: newCaptureRetryID(t), ParticipantGeneration: 1, Source: captureplane.TrackSourceMicrophone, Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto}},
						}}
					} else {
						command.Input = capturesignaling.CommandInput{RenegotiateCaptureConnection: &captureplane.RenegotiateCaptureConnectionInput{
							Connection: connection, NegotiationID: created.Result.CreateCaptureConnection.Negotiation.ID, Description: captureplane.Description{Type: "answer", SDP: "v=0\r\n"},
						}}
					}
					_, signalingErr := service.Execute(ctx, capturesignaling.ExecuteRequest{Command: command})
					lease := recordingpipeline.LeaseInput{JobID: job.ID, AttemptCount: job.AttemptCount, FencingGeneration: job.FencingGeneration, CaptureEpoch: envelope.CaptureEpoch, EnvelopeDigest: job.Authority.EnvelopeDigest, LeaseToken: *job.LeaseToken, LeaseOwner: *job.LeaseOwner}
					if signalingErr == nil {
						completed, err := postgres.NewRecordingPipelineRepository(sqlc.New(tx)).CompleteCapture(ctx, lease, newCaptureRetryID(t))
						if err != nil {
							t.Fatalf("complete recovered capture: %v", err)
						}
						state = completed.State
						break
					}
					if !errors.Is(signalingErr, capturesignaling.ErrProviderFailure) && !errors.Is(signalingErr, capturesignaling.ErrTimeout) {
						t.Fatalf("unexpected signaling failure: %v", signalingErr)
					}
					availableAt := time.Now().Add(recorderworker.DefaultAttemptRetryDelay)
					failed, err := repository.Fail(ctx, recordingpipeline.FailureInput{LeaseInput: lease, AvailableAt: availableAt, ErrorCode: "capture_attempt_failed", ErrorDetail: signalingErr.Error()})
					if err != nil {
						t.Fatalf("fail attempt: %v", err)
					}
					state = failed.State
					if state == recordingpipeline.JobStateTerminalFailure {
						break
					}
					if !failed.AvailableAt.Equal(availableAt.Truncate(time.Microsecond)) {
						t.Fatalf("lost durable attempt backoff: %s", failed.AvailableAt)
					}
					backoff += recorderworker.DefaultAttemptRetryDelay
					// Advance only the durable availability clock, not the lease or
					// fencing checks. This is not a wall-clock performance test.
					execCleanupFixture(t, tx, `update recording_jobs set available_at=now() where id=$1`, job.ID.Bytes())
				}
				t.Logf("state=%s attempts=%d provider_calls=%d scheduled_backoff=%s", state, attempts, calls.Load(), backoff)
				var retained int
				if err := tx.QueryRow(ctx, `select count(*) from recording_bundles where recording_id=$1 and object_key='fixture/committed-before-outage' and byte_size=9 and checksum=decode(repeat('ab',32),'hex')`, identity.RecordingID.Bytes()).Scan(&retained); err != nil || retained != 1 {
					t.Fatalf("committed bundle lost across provider outage: retained=%d err=%v", retained, err)
				}
				if permanent {
					if state != recordingpipeline.JobStateTerminalFailure || attempts != recordingpipeline.DefaultCaptureAttemptLimit || backoff < 4*time.Minute {
						t.Fatalf("permanent outage did not exhaust a bounded multi-minute budget: state=%s attempts=%d backoff=%s", state, attempts, backoff)
					}
				} else if state != recordingpipeline.JobStateSucceeded {
					t.Fatalf("transient outage lost the recording before provider recovery: state=%s attempts=%d", state, attempts)
				}
			})
		}
	}
}

type captureRetryTransaction struct{ pgx.Tx }

func (tx captureRetryTransaction) BeginTx(ctx context.Context, _ pgx.TxOptions) (pgx.Tx, error) {
	return tx.Begin(ctx)
}

type captureRetryResolver struct{ captureplane.CapturePlane }

func (r captureRetryResolver) Resolve(context.Context, captureplane.CaptureIdentity) (captureplane.CapturePlane, error) {
	return r.CapturePlane, nil
}

func newCaptureRetryID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func newCaptureRetryFixture(t *testing.T) (pgx.Tx, postgres.RecordingPipelineRepository, captureplane.CaptureIdentity) {
	t.Helper()
	if testing.Short() {
		t.Skip("postgres integration")
	}
	url := os.Getenv(config.DatabaseURL)
	if url == "" {
		url = config.DefaultDatabaseURL
	}
	pool, err := pgxpool.New(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(t.Context()); err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	identity := captureplane.CaptureIdentity{TenantID: newCaptureRetryID(t), SpaceID: newCaptureRetryID(t), EpisodeID: newCaptureRetryID(t), RecordingID: newCaptureRetryID(t)}
	execCleanupFixture(t, tx, `insert into tenants(id,name) values($1,'capture retry fixture')`, identity.TenantID.Bytes())
	execCleanupFixture(t, tx, `insert into spaces(id,name,tenant_id,slug,media_plane) values($1,'capture retry fixture',$2,'capture-retry','cf_sfu')`, identity.SpaceID.Bytes(), identity.TenantID.Bytes())
	execCleanupFixture(t, tx, `insert into episodes(id,status,space_id,tenant_id,config_snapshot) values($1,'active',$2,$3,'{"roles":{"collaborator":["publishAudio","publishVideo","subscribe"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":86400,"maximum_episode_duration_seconds":86400,"linger_window_seconds":0,"artifact_policy":{"schema_version":"episode_config.v2","recording":{"mode":"manual","profile":"composite_720p_v1","retention_seconds":0},"transcription":{"mode":"on_demand","retention_seconds":0,"source_window_seconds":86400,"provider_policy_version":"fixture"}}}'::jsonb)`, identity.EpisodeID.Bytes(), identity.SpaceID.Bytes(), identity.TenantID.Bytes())
	execCleanupFixture(t, tx, `insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes) values($1,$2,$3,'{"status":"active","participants":[]}',1,decode(repeat('00',32),'hex'),37)`, identity.TenantID.Bytes(), identity.SpaceID.Bytes(), identity.EpisodeID.Bytes())
	repository := postgres.NewRecordingPipelineRepositoryWithQueriesAndTransactor(sqlc.New(tx), captureRetryTransaction{tx}, nil)
	profile, err := recordingpresentation.NewComposite720PProfile()
	if err != nil {
		t.Fatal(err)
	}
	repository, err = repository.WithRecordingPresentationProfile(profile)
	if err != nil {
		t.Fatal(err)
	}
	_, err = repository.Reserve(t.Context(), recordingpipeline.ReservationInput{
		TenantID: identity.TenantID, SpaceID: identity.SpaceID, EpisodeID: identity.EpisodeID, RecordingID: identity.RecordingID,
		IdempotencyKey: "capture-retry", ParticipantCount: 1, PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion, MaxDuration: time.Hour, InputBitrateBPS: 1_000_000,
	}, newCaptureRetryID(t))
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	return tx, repository, identity
}
