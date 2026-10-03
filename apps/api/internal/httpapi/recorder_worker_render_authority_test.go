package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestRenderQualityCommitFitsBoundedWorkerTransport(t *testing.T) {
	body := recorderRenderCommitBody{VideoDegradation: make([]recordingpipeline.VideoDegradation, recordingpresentation.MaximumEvents)}
	for index := range body.VideoDegradation {
		body.VideoDegradation[index] = recordingpipeline.VideoDegradation{SourceID: "rps_" + strings.Repeat("f", 64), Kind: "screen_share", FrozenMS: 21_600_000, DroppedFrames: 2_147_483_647, Recoveries: 2_147_483_647}
	}
	identity := workeridentity.Identity{WorkerID: mustRecorderWorkerID(t, workerTestID), Role: workeridentity.RoleRender}
	input, _ := recordingRenderCommitInput(identity, body)
	digest, err := recordingrender.CommitDigest(input)
	if err != nil {
		t.Fatal(err)
	}
	body.CommitDigest = fmt.Sprintf("%x", digest)
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) <= maxRequestBodyBytes || len(encoded) >= recorderRenderCommitBodyLimit {
		t.Fatalf("maximum quality transport size = %d", len(encoded))
	}
	request := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(encoded))
	decoded, ok := decodeRecorderWorkerBodyWithLimit[recorderRenderCommitBody](httptest.NewRecorder(), request, recorderRenderCommitBodyLimit)
	if !ok || len(decoded.VideoDegradation) != recordingpresentation.MaximumEvents {
		t.Fatal("valid timeline's quality metadata cannot cross worker transport")
	}
	request = httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(encoded))
	if _, ok := decodeRecorderWorkerBody[recorderRenderCommitBody](httptest.NewRecorder(), request); ok {
		t.Fatal("ordinary API body limit was relaxed")
	}
}

const (
	workerTestRenderInputHandle   = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	workerTestRenderObjectHandle  = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	workerTestHistoricalKeyHandle = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
)

type recorderRenderAuthorityServiceStub struct {
	RecorderRenderAuthorityService
	access func(context.Context, recordingrender.AccessKeyInput) (recordingrender.DataKey, error)
	commit func(context.Context, recordingrender.CommitInput) (recordingrender.CommitResult, error)
}

func (service recorderRenderAuthorityServiceStub) AccessRenderKey(ctx context.Context, input recordingrender.AccessKeyInput) (recordingrender.DataKey, error) {
	return service.access(ctx, input)
}

func TestRecorderRenderKeyAccessSelectsHistoricalEpochUnderCurrentLease(t *testing.T) {
	called := 0
	service := recorderRenderAuthorityServiceStub{access: func(_ context.Context, input recordingrender.AccessKeyInput) (recordingrender.DataKey, error) {
		called++
		if input.CaptureEpoch != 2 || input.Authority.CaptureEpoch != 3 || input.Authority.LeaseOwner != workerTestID || input.Authority.KeyHandle.String() != workerTestKeyHandle {
			t.Fatalf("render key input = %#v", input)
		}
		return recordingrender.DataKey{KeyHandle: mustRecorderWorkerID(t, workerTestHistoricalKeyHandle), CaptureEpoch: 2, Plaintext: make([]byte, 32)}, nil
	}}
	workerID := mustRecorderWorkerID(t, workerTestID)
	router := NewRecorderWorkerRouterWithControls(recorderWorkerServiceStub{}, recorderWorkerRouteVerifierStub{identity: workeridentity.Identity{WorkerID: workerID, Role: workeridentity.RoleRender}}, RecorderWorkerControlServices{RenderAuthority: service})
	body := recordingAuthorityJSON() + `,"space_id":"` + workerTestSpace + `","render_input_handle":"` + workerTestRenderInputHandle + `","key_handle":"` + workerTestKeyHandle + `","object_handle":"` + workerTestRenderObjectHandle + `","requested_capture_epoch":2}`
	response := httptest.NewRecorder()
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/render-keys/access", body))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"capture_epoch":2`) || !strings.Contains(response.Body.String(), workerTestHistoricalKeyHandle) {
		t.Fatalf("key access status=%d body=%s", response.Code, response.Body.String())
	}

	body = recordingAuthorityJSON() + `,"space_id":"` + workerTestSpace + `","render_input_handle":"` + workerTestRenderInputHandle + `","key_handle":"` + workerTestKeyHandle + `","object_handle":"` + workerTestRenderObjectHandle + `","requested_capture_epoch":4}`
	response = httptest.NewRecorder()
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/render-keys/access", body))
	if response.Code != http.StatusBadRequest || called != 1 {
		t.Fatalf("future key access status=%d called=%d body=%s", response.Code, called, response.Body.String())
	}
}

func (service recorderRenderAuthorityServiceStub) CommitRender(ctx context.Context, input recordingrender.CommitInput) (recordingrender.CommitResult, error) {
	return service.commit(ctx, input)
}

func TestRenderCommitLogsDegradationOnlyAfterAcceptance(t *testing.T) {
	for _, scenario := range []struct {
		name      string
		degraded  bool
		commitErr error
		status    int
	}{
		{"degraded", true, nil, http.StatusOK},
		{"clean", false, nil, http.StatusOK},
		{"rejected", true, recordingrender.ErrCommitConflict, http.StatusConflict},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			var output bytes.Buffer
			logger := observability.New(observability.Config{LogFormat: observability.LogFormatJSON}, &output).Logger()
			sources := make([]recordingpipeline.VideoDegradation, 20)
			for index := range sources {
				sources[index] = recordingpipeline.VideoDegradation{SourceID: fmt.Sprintf("private-source-%d", index), Kind: "camera"}
				if scenario.degraded {
					sources[index].FrozenMS = 1000
					sources[index].DroppedFrames = 30
					sources[index].Recoveries = 1
				}
			}
			called := false
			service := recorderRenderAuthorityServiceStub{commit: func(_ context.Context, input recordingrender.CommitInput) (recordingrender.CommitResult, error) {
				called = true
				if output.Len() != 0 {
					t.Fatalf("logged before commit: %s", output.String())
				}
				if len(input.VideoDegradation) != 20 {
					t.Fatal("quality metadata lost")
				}
				return recordingrender.CommitResult{}, scenario.commitErr
			}}
			router := NewRecorderWorkerRouterWithControls(recorderWorkerServiceStub{}, recorderWorkerRouteVerifierStub{identity: workeridentity.Identity{WorkerID: mustRecorderWorkerID(t, workerTestID), Role: workeridentity.RoleRender}}, RecorderWorkerControlServices{RenderAuthority: service, Logger: logger})
			var body recorderRenderCommitBody
			authority := recordingAuthorityJSON() + `,"space_id":"` + workerTestSpace + `","render_input_handle":"` + workerTestRenderInputHandle + `","key_handle":"` + workerTestKeyHandle + `","object_handle":"` + workerTestRenderObjectHandle + `"}`
			if err := json.Unmarshal([]byte(authority), &body); err != nil {
				t.Fatal(err)
			}
			duration := int64(10000)
			body.CommitDigest = workerTestDigest
			body.PresentationSHA256 = workerTestDigest
			body.FFprobeFactsDigest = workerTestDigest
			body.DurationMillis = duration
			body.VideoDegradation = sources
			body.Video = recorderRenderObjectReferenceBody{AllocationID: workerTestRenderObjectHandle, Purpose: "recording_video", ObjectKey: "private/export.mp4", ObjectETag: "etag", ContentType: "video/mp4", ByteSize: 2048, SHA256: workerTestDigest, DurationMillis: &duration}
			identity := workeridentity.Identity{WorkerID: mustRecorderWorkerID(t, workerTestID), Role: workeridentity.RoleRender}
			input, _ := recordingRenderCommitInput(identity, body)
			digest, err := recordingrender.CommitDigest(input)
			if err != nil {
				t.Fatal(err)
			}
			body.CommitDigest = fmt.Sprintf("%x", digest)
			encoded, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			response := httptest.NewRecorder()
			request := recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/renders/commit", string(encoded))
			request.Header.Set("x-chalk-journey-id", "private-journey")
			router.ServeHTTP(response, request)
			if response.Code != scenario.status || !called {
				t.Fatalf("status=%d called=%v body=%s", response.Code, called, response.Body.String())
			}
			if !scenario.degraded || scenario.commitErr != nil {
				if strings.Contains(output.String(), "recording.export.degraded") {
					t.Fatalf("unexpected degradation event: %s", output.String())
				}
				return
			}
			var event struct {
				Message         string `json:"msg"`
				JobID           string `json:"job_id"`
				DegradedSources int    `json:"degraded_sources"`
				FrozenMS        int64  `json:"frozen_ms"`
				OmittedSources  int    `json:"omitted_sources"`
				Sources         []struct {
					SourceIndex   int    `json:"source_index"`
					Kind          string `json:"kind"`
					FrozenMS      int64  `json:"frozen_ms"`
					DroppedFrames int    `json:"dropped_frames"`
					Recoveries    int    `json:"recoveries"`
					PlaceholderMS int64  `json:"placeholder_ms"`
				} `json:"sources"`
			}
			if err := json.Unmarshal(output.Bytes(), &event); err != nil {
				t.Fatalf("missing degradation event: %v; output=%s", err, output.String())
			}
			if strings.Count(output.String(), "\n") != 1 || event.Message != "recording.export.degraded" || event.JobID != workerTestJob || event.DegradedSources != 20 || event.FrozenMS != 20000 || event.OmittedSources != 4 || len(event.Sources) != 16 {
				t.Fatalf("unexpected event: %+v", event)
			}
			for index, source := range event.Sources {
				if source.SourceIndex != index || source.Kind != "camera" || source.FrozenMS != 1000 || source.DroppedFrames != 30 || source.Recoveries != 1 || source.PlaceholderMS != 0 {
					t.Fatalf("unexpected source counters: %+v", source)
				}
			}
			for _, forbidden := range []string{"private-", "source_id", "journey_id", "trace_id", "span_id", workerTestTenant, workerTestEpisode, workerTestRecord, workerTestID} {
				if strings.Contains(output.String(), forbidden) {
					t.Fatalf("event leaked %q: %s", forbidden, output.String())
				}
			}
		})
	}
}
