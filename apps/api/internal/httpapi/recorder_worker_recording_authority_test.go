package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjects"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

const (
	workerTestKeyHandle      = "77777777-7777-4777-8777-777777777777"
	workerTestObjectHandle   = "88888888-8888-4888-8888-888888888888"
	workerTestReservationID  = "99999999-9999-4999-8999-999999999999"
	workerTestAllocationID   = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	workerTestContextDigest  = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"
	workerTestManifestDigest = "efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef"
)

type recorderRecordingKeyServiceStub struct {
	get func(context.Context, recordingkeys.Authority) (recordingkeys.DataKey, error)
}

func (s recorderRecordingKeyServiceStub) GetOrCreate(ctx context.Context, authority recordingkeys.Authority) (recordingkeys.DataKey, error) {
	return s.get(ctx, authority)
}

type recorderRecordingObjectServiceStub struct {
	reserve  func(context.Context, recordingobjects.ReserveInput) (recordingobjects.Allocation, error)
	finalize func(context.Context, recordingobjects.FinalizeInput) (recordingobjects.AllocationResult, error)
	commit   func(context.Context, recordingobjects.CommitInput) (recordingobjects.Bundle, error)
}

func (s recorderRecordingObjectServiceStub) Reserve(ctx context.Context, input recordingobjects.ReserveInput) (recordingobjects.Allocation, error) {
	return s.reserve(ctx, input)
}

func (s recorderRecordingObjectServiceStub) Finalize(ctx context.Context, input recordingobjects.FinalizeInput) (recordingobjects.AllocationResult, error) {
	return s.finalize(ctx, input)
}

func (s recorderRecordingObjectServiceStub) Commit(ctx context.Context, input recordingobjects.CommitInput) (recordingobjects.Bundle, error) {
	return s.commit(ctx, input)
}

func TestRecorderRecordingKeyAccessIsCaptureOnlyAndNoStore(t *testing.T) {
	called := false
	keyService := recorderRecordingKeyServiceStub{get: func(_ context.Context, authority recordingkeys.Authority) (recordingkeys.DataKey, error) {
		called = true
		if authority.LeaseOwner != workerTestID || authority.KeyHandle != workerTestKeyHandle || authority.CaptureEpoch != 3 || authority.LeaseToken != "lease-token" {
			t.Fatalf("key authority = %+v", authority)
		}
		return recordingkeys.DataKey{KeyHandle: authority.KeyHandle, Plaintext: []byte("01234567890123456789012345678901"), CiphertextDigest: bytesOfLength(0xab, 32), ContextDigest: bytesOfLength(0xcd, 32), CaptureEpoch: authority.CaptureEpoch}, nil
	}}
	router := recorderRecordingAuthorityRouter(t, workeridentity.RoleCapture, keyService, nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/keys/access", recordingKeyAccessJSON()))
	if response.Code != http.StatusOK || !called || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("key status=%d called=%v headers=%v body=%s", response.Code, called, response.Header(), response.Body.String())
	}
	var body recorderRecordingKeyAccessResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode key response: %v", err)
	}
	plaintext, err := base64.StdEncoding.Strict().DecodeString(body.Plaintext)
	if err != nil || len(plaintext) != 32 || body.ContextDigest != workerTestContextDigest {
		t.Fatalf("key response = %+v plaintext=%d err=%v", body, len(plaintext), err)
	}

	called = false
	renderRouter := recorderRecordingAuthorityRouter(t, workeridentity.RoleRender, keyService, nil)
	response = httptest.NewRecorder()
	renderRouter.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/keys/access", recordingKeyAccessJSON()))
	if response.Code != http.StatusForbidden || called {
		t.Fatalf("render key status=%d called=%v body=%s", response.Code, called, response.Body.String())
	}
}

func TestRecorderRecordingObjectReserveFinalizeCommit(t *testing.T) {
	objectKey := "recordings/" + workerTestRecord + "/capture/3/bundles/12/" + workerTestAllocationID + ".bundle"
	service := recorderRecordingObjectServiceStub{
		reserve: func(_ context.Context, input recordingobjects.ReserveInput) (recordingobjects.Allocation, error) {
			if input.Authority.LeaseOwner != workerTestID || input.Authority.ObjectHandle != workerTestObjectHandle || input.ReservationRequestID != workerTestReservationID || len(input.EncryptionContextDigest) != 32 {
				t.Fatalf("reserve input = %+v", input)
			}
			return recordingobjects.Allocation{ID: workerTestAllocationID, ObjectKey: objectKey, SequenceNumber: 12, AllocationVersion: 13}, nil
		},
		finalize: func(_ context.Context, input recordingobjects.FinalizeInput) (recordingobjects.AllocationResult, error) {
			if input.AllocationID != workerTestAllocationID || input.ExpectedByteSize != 1234 || len(input.ExpectedChecksumSHA256) != 32 || input.MonotonicEndMillis != 10_000 || input.ContentType != recordingBundleContentType {
				t.Fatalf("finalize input = %+v", input)
			}
			expiresAt := time.Date(2099, 1, 1, 0, 10, 0, 0, time.UTC)
			return recordingobjects.AllocationResult{AllocationID: input.AllocationID, UploadToken: "opaque-upload-token", ExpiresAt: expiresAt, UploadURL: objectstorage.SignedURL{Method: http.MethodPut, URL: "https://objects.example/upload", ExpiresAt: expiresAt, SignedHeader: map[string][]string{"Content-Type": {recordingBundleContentType}}}}, nil
		},
		commit: func(_ context.Context, input recordingobjects.CommitInput) (recordingobjects.Bundle, error) {
			if input.UploadToken != "opaque-upload-token" || input.AllocationID != workerTestAllocationID || len(input.ManifestDigest) != 32 || input.MediaEndMillis != 10_000 {
				t.Fatalf("commit input = %+v", input)
			}
			committedAt := time.Date(2099, 1, 1, 0, 1, 0, 0, time.UTC)
			return recordingobjects.Bundle{Allocation: recordingobjects.Allocation{ID: input.AllocationID, ObjectKey: objectKey, SequenceNumber: 12, AllocationVersion: 13}, ObjectVersion: "r2-version", ObjectETag: "etag", ObjectChecksumSHA256: bytesOfLength(0xab, 32), ManifestDigest: append([]byte(nil), input.ManifestDigest...), CommittedAt: committedAt}, nil
		},
	}
	router := recorderRecordingAuthorityRouter(t, workeridentity.RoleCapture, nil, service)

	response := httptest.NewRecorder()
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/bundles/reserve", recordingObjectAuthorityJSON()+`,"reservation_request_id":"`+workerTestReservationID+`","encryption_context_digest":"`+workerTestContextDigest+`"}`))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"allocation_version":13`) || !strings.Contains(response.Body.String(), objectKey) {
		t.Fatalf("reserve status=%d body=%s", response.Code, response.Body.String())
	}

	checksum := strings.Repeat("ab", 32)
	response = httptest.NewRecorder()
	finalize := recordingObjectAuthorityJSON() + `,"allocation_id":"` + workerTestAllocationID + `","byte_size":1234,"checksum_sha256":"` + checksum + `","content_type":"` + recordingBundleContentType + `","codec":"opus","monotonic_start_millis":0,"monotonic_end_millis":10000,"media_start_millis":0,"media_end_millis":10000}`
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/bundles/finalize", finalize))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"upload_token":"opaque-upload-token"`) || !strings.Contains(response.Body.String(), `"method":"PUT"`) {
		t.Fatalf("finalize status=%d body=%s", response.Code, response.Body.String())
	}

	response = httptest.NewRecorder()
	commit := recordingObjectAuthorityJSON() + `,"allocation_id":"` + workerTestAllocationID + `","upload_token":"opaque-upload-token","manifest_digest":"` + workerTestManifestDigest + `","monotonic_start_millis":0,"monotonic_end_millis":10000,"media_start_millis":0,"media_end_millis":10000}`
	router.ServeHTTP(response, recorderWorkerRequest(http.MethodPost, "/internal/v1/recorder/bundles/commit", commit))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"object_version":"r2-version"`) || !strings.Contains(response.Body.String(), `"allocation_version":13`) {
		t.Fatalf("commit status=%d body=%s", response.Code, response.Body.String())
	}
}

func recorderRecordingAuthorityRouter(t *testing.T, role workeridentity.Role, keys RecorderRecordingKeyService, objects RecorderRecordingObjectService) http.Handler {
	t.Helper()
	workerID := mustRecorderWorkerID(t, workerTestID)
	return NewRecorderWorkerRouterWithControls(recorderWorkerServiceStub{}, recorderWorkerRouteVerifierStub{identity: workeridentity.Identity{WorkerID: workerID, Role: role}}, RecorderWorkerControlServices{RecordingKeys: keys, RecordingObjects: objects})
}

func recordingKeyAccessJSON() string {
	return recordingAuthorityJSON() + `,"key_handle":"` + workerTestKeyHandle + `"}`
}

func recordingObjectAuthorityJSON() string {
	return recordingAuthorityJSON() + `,"object_handle":"` + workerTestObjectHandle + `"`
}

func recordingAuthorityJSON() string {
	return `{"tenant_id":"` + workerTestTenant + `","episode_id":"` + workerTestEpisode + `","recording_id":"` + workerTestRecord + `","job_id":"` + workerTestJob + `","attempt_count":1,"fencing_generation":2,"capture_epoch":3,"envelope_digest":"` + workerTestDigest + `","lease_token":"lease-token","lease_owner":"` + workerTestID + `","lease_expires_at":"2099-01-01T00:00:00Z"`
}

func bytesOfLength(value byte, length int) []byte {
	output := make([]byte, length)
	for index := range output {
		output[index] = value
	}
	return output
}
