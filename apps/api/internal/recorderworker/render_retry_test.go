package recorderworker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingdecode"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRenderRetriesFinishingRequestsWithoutRenderingAgain(t *testing.T) {
	for _, stage := range []string{"reserve", "finalize", "upload", "object", "render"} {
		for _, failures := range []int{1, 3} {
			for _, lostResponse := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%d/lost=%t", stage, failures, lostResponse), func(t *testing.T) {
					attempt, control, compose := retryAttemptForTest(t)
					control.stage, control.failures, control.lostResponse = stage, failures, lostResponse
					if err := attempt.Run(context.Background()); err != nil {
						t.Fatal(err)
					}
					if !attempt.committed || compose.calls != 1 || control.allocationCount != 1 || control.commits != 1 {
						t.Fatalf("committed=%t renders=%d allocations=%d commits=%d", attempt.committed, compose.calls, control.allocationCount, control.commits)
					}
					if control.calls[stage] != failures+1 {
						t.Fatalf("calls=%v", control.calls)
					}
				})
			}
		}
	}
}

func TestRenderRetryStops(t *testing.T) {
	for _, stage := range []string{"reserve", "finalize", "upload", "object", "render"} {
		for _, test := range []struct {
			name  string
			err   error
			count int
		}{
			{"permanent", errors.New("permanent failure"), 1},
			{"fenced", HTTPError{Status: 409, Retryable: true, Fenced: true}, 1},
			{"terminal", HTTPError{Status: 410, Retryable: true, Terminal: true}, 1},
			{"bound", TransportError{Err: errors.New("offline")}, renderControlPlaneAttempts},
		} {
			t.Run(stage+"/"+test.name, func(t *testing.T) {
				attempt, control, compose := retryAttemptForTest(t)
				control.stage, control.failures, control.failure = stage, 100, test.err
				err := attempt.Run(context.Background())
				if !errors.Is(err, test.err) || control.calls[stage] != test.count || compose.calls != 1 || attempt.committed {
					t.Fatalf("err=%v calls=%v renders=%d committed=%t", err, control.calls, compose.calls, attempt.committed)
				}
			})
		}
	}
}

func TestRenderRetryCancellationAndLeaseRenewal(t *testing.T) {
	attempt, control, _ := retryAttemptForTest(t)
	control.stage, control.failures = "finalize", 100
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	attempt.config.RetryWait = func(ctx context.Context, wait time.Duration) error {
		lease, err := renderLeaseInput(attempt.claim, DefaultRenderLease)
		if err != nil {
			t.Fatal(err)
		}
		expires := attempt.currentAuthority().LeaseExpiresAt.Add(time.Minute)
		if _, err := attempt.RenewLease(func() (recordingpipeline.LeaseInput, time.Time, error) { return lease, expires, nil }); err != nil {
			t.Fatal(err)
		}
		cancel()
		return ctx.Err()
	}
	if err := attempt.Run(ctx); !errors.Is(err, context.Canceled) || control.calls["finalize"] != 1 {
		t.Fatalf("err=%v calls=%v", err, control.calls)
	}
}

func TestRenderRetryUsesRenewedAuthority(t *testing.T) {
	attempt, control, _ := retryAttemptForTest(t)
	control.stage, control.failures = "reserve", 1
	expires := attempt.currentAuthority().LeaseExpiresAt.Add(time.Minute)
	attempt.config.RetryWait = func(context.Context, time.Duration) error {
		lease, err := renderLeaseInput(attempt.claim, DefaultRenderLease)
		if err != nil {
			return err
		}
		_, err = attempt.RenewLease(func() (recordingpipeline.LeaseInput, time.Time, error) { return lease, expires, nil })
		return err
	}
	if err := attempt.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if control.reservation.Authority.LeaseExpiresAt != expires {
		t.Fatal("retry used old lease")
	}
}

func TestRenderRetryHonorsContextDeadline(t *testing.T) {
	attempt, _, _ := retryAttemptForTest(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls := 0
	_, err := retryRenderCall(ctx, attempt, "commit_render", func(context.Context) (bool, error) { calls++; return true, nil })
	if !errors.Is(err, context.Canceled) || calls != 0 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
	calls = 0
	_, err = retryRenderCall(context.Background(), attempt, "commit_render", func(ctx context.Context) (bool, error) {
		calls++
		if calls == 1 {
			if _, ok := ctx.Deadline(); ok {
				t.Fatal("healthy first request received retry deadline")
			}
			return false, TransportError{Err: errors.New("offline")}
		}
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > DefaultCompletionRetry {
			t.Fatal("retry budget missing")
		}
		return false, errors.New("stop")
	})
	if err == nil || calls != 2 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
}

func TestRenderRetryCancellationRetainsAPIError(t *testing.T) {
	attempt, _, _ := retryAttemptForTest(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	attempt.config.RetryWait = func(ctx context.Context, _ time.Duration) error { cancel(); return ctx.Err() }
	last := HTTPError{Status: http.StatusServiceUnavailable, Code: "service_unavailable", Retryable: true}
	_, err := retryRenderCall(ctx, attempt, "commit_render", func(context.Context) (bool, error) { return false, last })
	var httpErr HTTPError
	if !errors.Is(err, context.Canceled) || !errors.As(err, &httpErr) || httpErr != last {
		t.Fatalf("lost cancellation evidence: %v", err)
	}

}

type retryRenderControl struct {
	*transcriptionAttemptControl
	stage        string
	failures     int
	failure      error
	lostResponse bool
	calls        map[string]int
	reservation  recordingrender.ReserveObjectInput
	manifest     []byte
	uploaded     bool
	commits      int
	commitDigest []byte
}

func (c *retryRenderControl) fail(stage string) error {
	c.calls[stage]++
	if c.stage == stage && c.calls[stage] <= c.failures {
		if c.failure != nil {
			return c.failure
		}
		return TransportError{Err: errors.New("response lost")}
	}
	return nil
}

func (c *retryRenderControl) DownloadRenderObject(ctx context.Context, object recordingrender.DownloadableObject, path string) error {
	if object.ObjectKey == c.input.AssetManifest.ObjectKey {
		return os.WriteFile(path, c.manifest, 0600)
	}
	return c.transcriptionAttemptControl.DownloadRenderObject(ctx, object, path)
}

func (c *retryRenderControl) ReserveRenderObject(_ context.Context, input recordingrender.ReserveObjectInput) (recordingrender.ReservedObject, error) {
	err := c.fail("reserve")
	if err != nil && !c.lostResponse {
		return recordingrender.ReservedObject{}, err
	}
	if c.allocationCount == 0 {
		c.reservation = input
		id := input.ReservationRequestID
		c.allocationCount++
		c.reserved = map[utilities.ID]recordingrender.ReservedObject{id: {AllocationID: id, ObjectKey: "recordings/test/video.mp4", Purpose: input.Purpose, AllocationVersion: 1}}
	}
	if input.ReservationRequestID != c.reservation.ReservationRequestID {
		return recordingrender.ReservedObject{}, errors.New("reservation changed")
	}
	c.reservation = input
	for _, result := range c.reserved {
		return result, err
	}
	panic("missing reservation")
}

func (c *retryRenderControl) FinalizeRenderObject(ctx context.Context, input recordingrender.FinalizeObjectInput) (recordingrender.FinalizedObject, error) {
	err := c.fail("finalize")
	if err != nil && !c.lostResponse {
		return recordingrender.FinalizedObject{}, err
	}
	result, innerErr := c.transcriptionAttemptControl.FinalizeRenderObject(ctx, input)
	if innerErr != nil {
		return result, innerErr
	}
	return result, err
}

func (c *retryRenderControl) UploadRenderObject(ctx context.Context, signed objectstorage.SignedURL, reader io.Reader, size int64) error {
	// Consume even failed requests: retries must reopen the file at byte zero.
	if err := c.transcriptionAttemptControl.UploadRenderObject(ctx, signed, reader, size); err != nil {
		return err
	}
	err := c.fail("upload")
	if err != nil && !c.lostResponse {
		return err
	}
	if c.uploaded {
		if err != nil {
			return err
		}
		return HTTPError{Status: http.StatusPreconditionFailed}
	}
	c.uploaded = true
	return err
}

func (c *retryRenderControl) CommitRenderObject(ctx context.Context, input recordingrender.CommitObjectInput) (recordingrender.CommittedObject, error) {
	err := c.fail("object")
	if err != nil && !c.lostResponse {
		return recordingrender.CommittedObject{}, err
	}
	if !c.uploaded {
		return recordingrender.CommittedObject{}, errors.New("object missing")
	}
	result, innerErr := c.transcriptionAttemptControl.CommitRenderObject(ctx, input)
	if innerErr != nil {
		return result, innerErr
	}
	return result, err
}

func (c *retryRenderControl) CommitRender(_ context.Context, input recordingrender.CommitInput) (recordingrender.CommitResult, error) {
	err := c.fail("render")
	if err != nil && !c.lostResponse {
		return recordingrender.CommitResult{}, err
	}
	if c.commits == 0 {
		c.commits++
		c.commitDigest = append([]byte(nil), input.CommitDigest...)
	}
	if !bytes.Equal(c.commitDigest, input.CommitDigest) {
		return recordingrender.CommitResult{}, errors.New("commit changed")
	}
	return recordingrender.CommitResult{}, err
}

type retryCompose struct{ calls int }

func (c *retryCompose) Compose(_ context.Context, _ FrameRenderRequest, path string) (ComposeResult, error) {
	c.calls++
	return ComposeResult{}, os.WriteFile(path, []byte("finished video"), 0600)
}

type retryCommands struct {
	width, height int
	duration      int64
}

func (c retryCommands) Run(context.Context, string, ...string) ([]byte, error) {
	return []byte(fmt.Sprintf(`{"streams":[{"codec_type":"video","codec_name":"h264","width":%d,"height":%d,"pix_fmt":"yuv420p","avg_frame_rate":"15/1","start_time":"0"},{"codec_type":"audio","codec_name":"aac","profile":"LC","sample_rate":"48000","channels":2,"start_time":"0"}],"format":{"format_name":"mp4","duration":"%.3f","start_time":"0"}}`, c.width, c.height, float64(c.duration)/1000)), nil
}

func retryAttemptForTest(t *testing.T) (*ProductionRenderAttempt, *retryRenderControl, *retryCompose) {
	t.Helper()
	attempt, base, _ := transcriptionAttemptForTest(t, artifactpolicy.TranscriptionDisabled, nil)
	attempt.claim.Envelope.Kind = recordingpipeline.JobKindRender
	attempt.claim.Envelope.HardDeadline = time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
	timeline, err := recordingpresentation.Decode(base.presentation)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := json.Marshal(recordingpresentation.AssetManifest{SchemaVersion: recordingpresentation.AssetManifestSchemaVersion, PresentationHandle: base.input.PresentationHandle.String()})
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(manifest)
	base.input.AssetManifest = recordingrender.DownloadableObject{ObjectFacts: recordingrender.ObjectFacts{ObjectKey: "recordings/test/assets.json", ByteSize: int64(len(manifest)), SHA256: hash[:]}, Download: base.input.Presentation.Download}
	control := &retryRenderControl{transcriptionAttemptControl: base, calls: make(map[string]int), manifest: manifest}
	compose := &retryCompose{}
	attempt.config.Control = control
	attempt.config.Compose = compose
	attempt.config.Commands = retryCommands{timeline.Initial.Profile.Viewport.Width, timeline.Initial.Profile.Viewport.Height, timeline.Clock.DurationMillis}
	attempt.config.RetryWait = func(context.Context, time.Duration) error { return nil }
	attempt.config.Decode = func(context.Context, recordingdecode.Request) (recordingdecode.Result, error) {
		return recordingdecode.Result{Index: recordingdecode.Index{Sources: []recordingdecode.Source{{SourceID: "source"}}}}, nil
	}
	return attempt, control, compose
}

// The real daemon must reach RenewLease during the lost-answer wait, while the
// production attempt keeps the heartbeat callback outside the final commit.
func TestRenderRetryFinalCommitBlocksDueHeartbeat(t *testing.T) {
	attempt, control, compose := retryAttemptForTest(t)
	control.stage, control.failures, control.lostResponse = "render", 1, true
	tick := make(chan time.Time, 1)
	renewing := make(chan struct{})
	wrapped := &renderRetryHeartbeatAttempt{ProductionRenderAttempt: attempt, renewing: renewing}
	daemonControl := &renderControlPlaneStub{heartbeat: func(recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
		return recordingpipeline.Job{}, HTTPError{Status: http.StatusConflict, Code: "lease.stale", Fenced: true}
	}}
	daemon := renderDaemonForTest(t, daemonControl, wrapped, func(time.Duration) <-chan time.Time { return tick })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	attempt.config.RetryWait = func(ctx context.Context, _ time.Duration) error {
		if control.commits != 1 || attempt.committed {
			return errors.New("fake server did not commit before losing the answer")
		}
		if attempt.leaseGate.TryLock() {
			attempt.leaseGate.Unlock()
			return errors.New("final commit released the heartbeat gate during replay")
		}
		tick <- time.Now()
		select {
		case <-renewing:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if err := daemon.runClaim(ctx, attempt.claim); err != nil {
		t.Fatal(err)
	}
	select {
	case <-renewing:
	default:
		t.Fatal("heartbeat was not due during replay")
	}
	if !attempt.committed || compose.calls != 1 || control.commits != 1 || control.calls["render"] != 2 || daemonControl.heartbeatCalls != 0 || daemonControl.failed != nil {
		t.Fatalf("committed=%t renders=%d commits=%d requests=%d heartbeats=%d failure=%v", attempt.committed, compose.calls, control.commits, control.calls["render"], daemonControl.heartbeatCalls, daemonControl.failed)
	}
}

type renderRetryHeartbeatAttempt struct {
	*ProductionRenderAttempt
	renewing chan struct{}
}

func (attempt *renderRetryHeartbeatAttempt) RenewLease(renew RenderLeaseRenewal) (recordingpipeline.LeaseInput, error) {
	close(attempt.renewing)
	return attempt.ProductionRenderAttempt.RenewLease(renew)
}

func TestRenderRetryFinishingResponseRead(t *testing.T) {
	for _, path := range []string{"render-objects/reserve", "render-objects/finalize", "render-objects/commit", "renders/commit"} {
		for _, partial := range []string{"", `{"allocation_id":`} {
			t.Run(path+fmt.Sprintf("/bytes_%d", len(partial)), func(t *testing.T) {
				calls := 0
				server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					if calls == 1 {
						w.Header().Set("Content-Length", "100")
						w.WriteHeader(http.StatusOK)
						_, _ = io.WriteString(w, partial)
						return
					}
					_, _ = io.WriteString(w, `{}`)
				}))
				defer server.Close()
				client, err := NewControlPlaneClient(server.URL, server.Client())
				if err != nil {
					t.Fatal(err)
				}
				attempt, _, _ := retryAttemptForTest(t)
				_, err = retryRenderCall(context.Background(), attempt, "commit_render", func(ctx context.Context) ([]byte, error) {
					body, _, err := client.doRenderFinish(ctx, "/internal/v1/recorder/"+path, struct{}{})
					return body, err
				})
				if err != nil || calls != 2 {
					t.Fatalf("err=%v requests=%d", err, calls)
				}
			})
		}
	}
}

func TestRenderRetryKeepsCompleteResponseFaultsPermanent(t *testing.T) {
	for _, body := range []string{strings.Repeat("x", ControlPlaneResponseLimit+1), `{"allocation_id":`, `{"allocation_id":"wrong"}`} {
		t.Run(fmt.Sprintf("bytes_%d", len(body)), func(t *testing.T) {
			calls := 0
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				_, _ = io.WriteString(w, body)
			}))
			defer server.Close()
			client, err := NewControlPlaneClient(server.URL, server.Client())
			if err != nil {
				t.Fatal(err)
			}
			attempt, _, _ := retryAttemptForTest(t)
			input := recordingrender.ReserveObjectInput{Authority: attempt.currentAuthority(), Purpose: recordingrender.PurposeRecordingVideo, ReservationRequestID: attempt.claim.ClaimRequestID}
			_, err = retryRenderCall(context.Background(), attempt, "reserve_object", func(ctx context.Context) (recordingrender.ReservedObject, error) {
				return client.ReserveRenderObject(ctx, input)
			})
			if !errors.Is(err, ErrControlPlaneProtocol) || errors.Is(err, ErrControlPlaneRetryable) || calls != 1 {
				t.Fatalf("err=%v requests=%d", err, calls)
			}
		})
	}
}

func TestRenderRetryLeavesCaptureResponseReadPermanent(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"job_id":`)
	}))
	defer server.Close()
	client, err := NewControlPlaneClient(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Complete(context.Background(), testLeaseInput(t))
	if !errors.Is(err, ErrControlPlaneProtocol) || errors.Is(err, ErrControlPlaneRetryable) {
		t.Fatalf("Capture response classification changed: %v", err)
	}
}

func TestRenderRetryReportsBoundedOutcome(t *testing.T) {
	previous := slog.Default()
	defer slog.SetDefault(previous)
	for _, test := range []struct {
		name               string
		failures, requests int
		outcome            string
	}{
		{"healthy", 0, 1, ""},
		{"recovered", 2, 3, "succeeded"},
		{"exhausted", renderControlPlaneAttempts, renderControlPlaneAttempts, "gave_up"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
			attempt, control, _ := retryAttemptForTest(t)
			control.stage, control.failures = "render", test.failures
			err := attempt.Run(context.Background())
			if (err != nil) != (test.outcome == "gave_up") {
				t.Fatalf("err=%v", err)
			}
			if test.outcome == "" {
				if output.Len() != 0 {
					t.Fatalf("healthy request logged a retry: %s", output.String())
				}
				return
			}
			var signal struct {
				Message   string `json:"msg"`
				Operation string `json:"operation"`
				Requests  int    `json:"requests"`
				Outcome   string `json:"outcome"`
			}
			if err := json.Unmarshal(output.Bytes(), &signal); err != nil {
				t.Fatal(err)
			}
			if signal.Message != "recorder render finishing retry" || signal.Operation != "commit_render" || signal.Requests != test.requests || signal.Outcome != test.outcome {
				t.Fatalf("unexpected retry signal: %s", output.String())
			}
		})
	}
}
