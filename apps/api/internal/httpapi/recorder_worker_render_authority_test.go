package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
