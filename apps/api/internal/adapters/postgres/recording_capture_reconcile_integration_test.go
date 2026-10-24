package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

// Derived from the independent round-2 judge probe. Use the real coordinator,
// durable signaling fences, and HTTP adapter; only Cloudflare is simulated.
func TestRecordingCaptureReconcileRetirementPostgres(t *testing.T) {
	for _, failure := range []string{"replacement pull", "replacement renegotiation", "durable stop on final attempt"} {
		t.Run(failure, func(t *testing.T) {
			stopped := failure == "durable stop on final attempt"
			renegotiation := failure == "replacement renegotiation"
			tx, repository, identity := newCaptureRetryFixture(t)
			execCleanupFixture(t, tx, `update recording_jobs set attempt_count=attempt_limit-1 where recording_id=$1 and kind='capture'`, identity.RecordingID.Bytes())
			job, err := repository.Claim(t.Context(), recordingpipeline.ClaimInput{ClaimRequestID: newCaptureRetryID(t), Kind: recordingpipeline.JobKindCapture, Owner: "judge-reconcile", LeaseToken: "judge-reconcile-lease", LeaseFor: time.Minute})
			if err != nil {
				t.Fatal(err)
			}
			authority, err := recordercapture.NewAttemptAuthorityAt(job.Authority.Envelope, job.Authority.EnvelopeDigest, capturesignaling.WorkerLease{Owner: *job.LeaseOwner, Token: *job.LeaseToken, ExpiresAt: *job.LeaseExpiresAt}, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			var pulls, inspects, closes, renegotiations atomic.Int32
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch {
				case strings.HasSuffix(r.URL.Path, "/sessions/new"):
					fmt.Fprint(w, `{"sessionId":"judge-session"}`)
				case r.Method == http.MethodGet:
					inspects.Add(1)
					fmt.Fprint(w, `{"tracks":[{"mid":"1","sessionId":"owner-two","trackName":"track-two","location":"remote"}]}`)
				case strings.HasSuffix(r.URL.Path, "/tracks/close"):
					closes.Add(1)
					if stopped && inspects.Load() == 0 {
						if _, err := repository.RequestStop(t.Context(), identity.TenantID, identity.EpisodeID, identity.RecordingID, newCaptureRetryID(t)); err != nil {
							t.Error(err)
						}
					}
					if inspects.Load() > 0 {
						fmt.Fprint(w, `{"tracks":[{"mid":"1"}]}`)
					} else {
						fmt.Fprint(w, `{"tracks":[{"mid":"0"}]}`)
					}
				case strings.HasSuffix(r.URL.Path, "/renegotiate"):
					renegotiations.Add(1)
					w.WriteHeader(http.StatusInternalServerError)
					fmt.Fprint(w, `{"errorCode":"internal_error"}`)
				case strings.HasSuffix(r.URL.Path, "/tracks/new"):
					if pulls.Add(1) > 1 {
						if renegotiation {
							fmt.Fprint(w, `{"tracks":[{"sessionId":"owner-two","trackName":"track-two","mid":"1","location":"remote"}],"requiresImmediateRenegotiation":true,"sessionDescription":{"type":"offer","sdp":"v=0\r\n"}}`)
							return
						}
						w.WriteHeader(http.StatusInternalServerError)
						fmt.Fprint(w, `{"errorCode":"internal_error"}`)
						return
					}
					fmt.Fprint(w, `{"tracks":[{"sessionId":"owner-one","trackName":"track-one","mid":"0","location":"remote"}]}`)
				default:
					t.Errorf("unexpected provider request: %s %s", r.Method, r.URL.Path)
				}
			}))
			listener, err := net.Listen("tcp", "127.0.0.1:3960")
			if err != nil {
				t.Fatal(err)
			}
			server.Listener = listener
			server.Start()
			t.Cleanup(server.Close)
			adapter, err := sfu.NewAdapterWithClient(config.CloudflareRealtimeConfig{RealtimeAppID: "fixture-app", RealtimeAppSecret: "fixture-secret", RequestTimeout: time.Second}, server.Client(), server.URL)
			if err != nil {
				t.Fatal(err)
			}
			service, err := capturesignaling.NewService(postgres.NewRecordingCaptureSignalingRepositoryWithTransactor(captureRetryTransaction{tx}, nil), captureRetryResolver{adapter}, capturesignaling.Options{})
			if err != nil {
				t.Fatal(err)
			}
			coordinator, err := recordercapture.NewCoordinator(authority, service, reconcileRetirementPeer{}, recordercapture.Config{})
			if err != nil {
				t.Fatal(err)
			}
			plan := func(revision captureplane.PlanRevision, name string) captureplan.Plan {
				participant := captureplan.ParticipantSnapshot{ID: newCaptureRetryID(t), Generation: 1, DisplayName: "Judge", JoinOrdinal: 1, Lifecycle: captureplan.ParticipantActive}
				plan, err := captureplan.NewPlan(captureplan.PlanInput{
					Authority: captureplan.PlanAuthority{PlanHandle: authority.PlanHandle, TenantID: authority.TenantID, SpaceID: authority.SpaceID, EpisodeID: authority.EpisodeID, RecordingID: authority.RecordingID, JobID: authority.JobID, AttemptCount: authority.AttemptCount, FencingGeneration: authority.FencingGeneration, CaptureEpoch: authority.CaptureEpoch, EnvelopeDigest: authority.EnvelopeDigest},
					Revision:  revision, Cursors: captureplan.PlanCursors{EpisodeControlRevision: int64(revision), ProviderIncarnation: 1, ProviderSequence: int64(revision)}, LayoutProfile: captureplan.LayoutProfileComposite720PV1, ParticipantLimit: 10, InputBitrateBPS: 4000000, EffectiveDeadline: authority.HardDeadline, StopState: captureplan.StopStateRunning,
					Participants: []captureplan.ParticipantSnapshot{participant}, Tracks: []captureplan.TrackSnapshot{{ParticipantID: participant.ID, ParticipantGeneration: 1, Source: captureplane.TrackSourceMicrophone, Kind: captureplane.TrackKindAudio, OwnerReference: captureplane.ProviderReference("owner-" + name), TrackReference: captureplane.ProviderReference("track-" + name), OwnerMID: captureplane.ProviderReference("owner-mid-" + name), PublicationReference: captureplan.PublicationReference("publication-" + name), RequestedLayer: captureplane.TrackLayerAuto}},
				})
				if err != nil {
					t.Fatal(err)
				}
				return plan
			}
			if _, err := coordinator.Bootstrap(t.Context(), plan(1, "one")); err != nil {
				t.Fatalf("bootstrap: %v", err)
			}
			_, reconcileErr := coordinator.Reconcile(t.Context(), plan(2, "two"))
			if reconcileErr == nil {
				t.Fatal("expected media failure")
			}
			if stopped && !errors.Is(reconcileErr, capturesignaling.ErrMediaStopped) {
				t.Fatalf("stop did not reach worker: %v", reconcileErr)
			}
			closeErr := coordinator.Close(t.Context(), true)
			var durableRevision int
			if err := tx.QueryRow(t.Context(), `select latest_plan_revision from recording_capture_connections where recording_id=$1`, identity.RecordingID.Bytes()).Scan(&durableRevision); err != nil {
				t.Fatal(err)
			}
			t.Logf("reconcile=%v cleanup=%v durable_revision=%d provider_inspects=%d provider_closes=%d", reconcileErr, closeErr, durableRevision, inspects.Load(), closes.Load())
			if closeErr != nil {
				t.Fatalf("allocated session cannot be retired after revision-2 failure: %v", closeErr)
			}
			if durableRevision != 2 || inspects.Load() != 1 || closes.Load() != 2 {
				t.Fatalf("retirement did not inspect and close the allocated session: revision=%d inspections=%d closes=%d", durableRevision, inspects.Load(), closes.Load())
			}
			if renegotiation && renegotiations.Load() != 1 {
				t.Fatalf("renegotiation failure was not exercised: %d calls", renegotiations.Load())
			}
			if stopped && (job.AttemptCount != job.AttemptLimit || pulls.Load() != 1) {
				t.Fatalf("stop must block the replacement pull on the final attempt: job=%+v pulls=%d", job, pulls.Load())
			}
			// Successful retirement leaves normal completion available even at the media
			// attempt limit. No media failure or completion-only claim is needed.
			lease := recordingpipeline.LeaseInput{JobID: job.ID, AttemptCount: job.AttemptCount, FencingGeneration: job.FencingGeneration, CaptureEpoch: job.Authority.Envelope.CaptureEpoch, EnvelopeDigest: job.Authority.EnvelopeDigest, LeaseToken: *job.LeaseToken, LeaseOwner: *job.LeaseOwner}
			completed, err := postgres.NewRecordingPipelineRepository(sqlc.New(tx)).CompleteCapture(t.Context(), lease, newCaptureRetryID(t))
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("final_media_attempt=%d stored_limit=%d completion=%s", job.AttemptCount, job.AttemptLimit, completed.State)
			if completed.State != recordingpipeline.JobStateSucceeded {
				t.Fatalf("capture did not complete normally: %s", completed.State)
			}
		})
	}
}

type reconcileRetirementPeer struct{}

func (reconcileRetirementPeer) RegisterTracks([]captureplane.PulledCaptureTrack) error { return nil }
func (reconcileRetirementPeer) CreateLocalOffer(context.Context, ...captureplane.ProviderReference) (captureplane.Negotiation, error) {
	return captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}, nil
}
func (reconcileRetirementPeer) AnswerRemoteOffer(context.Context, captureplane.Negotiation) (captureplane.Description, error) {
	return captureplane.Description{Type: "answer", SDP: "v=0\r\n"}, nil
}
func (reconcileRetirementPeer) ApplyRemoteAnswer(context.Context, captureplane.Negotiation) error {
	return nil
}
