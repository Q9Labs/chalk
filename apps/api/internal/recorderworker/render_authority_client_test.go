package recorderworker

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestAccessRenderKeySelectsHistoricalEpochAndFencesResponse(t *testing.T) {
	now := time.Now().UTC()
	authority, err := renderAuthorityFromClaim(productionRenderClaimForTest(t, now), now)
	if err != nil {
		t.Fatal(err)
	}
	historicalKey := "12121212-1212-4212-8212-121212121212"
	responseEpoch := int64(2)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatalf("decode key access request: %v", err)
		}
		if request.URL.Path != "/internal/v1/recorder/render-keys/access" || body["requested_capture_epoch"] != float64(2) || body["capture_epoch"] != float64(authority.CaptureEpoch) || body["key_handle"] != authority.KeyHandle.String() {
			t.Fatalf("key access request path=%q body=%#v", request.URL.Path, body)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"key_handle": historicalKey, "capture_epoch": responseEpoch, "plaintext": base64.StdEncoding.EncodeToString(make([]byte, 32))})
	}))
	defer server.Close()
	client, err := NewControlPlaneClient(server.URL, server.Client())
	if err != nil {
		t.Fatalf("new control-plane client: %v", err)
	}
	input := recordingrender.AccessKeyInput{Authority: authority, CaptureEpoch: 2}
	key, err := client.AccessRenderKey(context.Background(), input)
	if err != nil {
		t.Fatalf("AccessRenderKey() error = %v", err)
	}
	clear(key.Plaintext)
	if key.CaptureEpoch != 2 || key.KeyHandle.String() != historicalKey {
		t.Fatalf("historical key = %#v", key)
	}
	responseEpoch = 3
	if _, err := client.AccessRenderKey(context.Background(), input); err == nil {
		t.Fatal("AccessRenderKey() accepted mismatched response epoch")
	}
}

func TestDecodeDownloadableRenderObjectAcceptsVersionlessImmutableFacts(t *testing.T) {
	response := renderObjectResponse{
		ObjectKey: "recordings/recording-1/presentation.json", ObjectETag: `"immutable-etag"`,
		ContentType: "application/json", ByteSize: 42, SHA256: strings.Repeat("a", 64),
		Download: renderDownloadResponse{Method: http.MethodGet, URL: "https://objects.example.test/presentation.json?signature=value", ExpiresAt: time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)},
	}
	object, err := decodeDownloadableRenderObject(response)
	if err != nil {
		t.Fatalf("decode versionless R2 object: %v", err)
	}
	if object.ObjectVersion != "" || object.ObjectKey != response.ObjectKey || object.ObjectETag != response.ObjectETag {
		t.Fatalf("decoded immutable facts = %#v", object.ObjectFacts)
	}

	response.ObjectETag = ""
	if _, err := decodeDownloadableRenderObject(response); err == nil {
		t.Fatal("download response without immutable ETag was accepted")
	}
	response.ObjectETag = `"immutable-etag"`
	response.ObjectKey = "../presentation.json"
	if _, err := decodeDownloadableRenderObject(response); err == nil {
		t.Fatal("download response with invalid object key was accepted")
	}
}

func TestDecodeRenderCommitAcceptsOnDemandSourceWithoutJobs(t *testing.T) {
	now := time.Now().UTC()
	authority, err := renderAuthorityFromClaim(productionRenderClaimForTest(t, now), now)
	if err != nil {
		t.Fatal(err)
	}
	input := recordingrender.CommitInput{
		Authority: authority, DurationMillis: 3_000,
		Video:               recordingrender.CommitObjectReference{Object: recordingrender.ObjectFacts{ObjectKey: "recordings/recording-1/video.mp4", ContentType: "video/mp4", ByteSize: 123, SHA256: make([]byte, 32)}},
		TranscriptionSource: &recordingrender.TranscriptionSource{},
	}
	sourceID := authority.RecordingID.String()
	response := renderCommitResponse{TranscriptionSourceID: &sourceID, TranscriptionJobIDs: []string{}}
	response.Artifact.RecordingID = authority.RecordingID.String()
	response.Artifact.TenantID = authority.TenantID.String()
	response.Artifact.RenderJobID = authority.JobID.String()
	response.Artifact.ObjectKey = input.Video.Object.ObjectKey
	response.Artifact.ContentType = input.Video.Object.ContentType
	response.Artifact.ByteSize = input.Video.Object.ByteSize
	response.Artifact.Checksum = strings.Repeat("00", 32)
	response.Artifact.DurationMillis = input.DurationMillis
	response.Artifact.CreatedAt = now.Format(time.RFC3339Nano)
	response.Artifact.CommittedAt = now.Format(time.RFC3339Nano)

	result, err := decodeRenderCommit(input, response)
	if err != nil {
		t.Fatalf("decode on-demand transcription source: %v", err)
	}
	if result.Transcription == nil || result.Transcription.SourceID != authority.RecordingID || len(result.Transcription.JobIDs) != 0 {
		t.Fatalf("decoded transcription admission = %#v", result.Transcription)
	}

	otherSource := authority.JobID.String()
	response.TranscriptionSourceID = &otherSource
	if _, err := decodeRenderCommit(input, response); err == nil {
		t.Fatal("cross-recording transcription source was accepted")
	}
}

func TestDecodeFinalizedRenderObjectUsesEarlierGrantDeadline(t *testing.T) {
	id, err := utilities.ParseID("00000000-0000-4000-8000-000000000001")
	if err != nil {
		t.Fatal(err)
	}
	expiry := time.Now().UTC().Add(time.Minute)
	input := recordingrender.FinalizeObjectInput{AllocationID: id, Purpose: recordingrender.PurposeRecordingVideo}
	response := renderFinalizeResponse{renderReserveResponse: renderReserveResponse{AllocationID: id.String(), Purpose: string(input.Purpose), AllocationVersion: 1}, UploadToken: "token", ExpiresAt: expiry.Format(time.RFC3339Nano)}
	response.Upload.Method = http.MethodPut
	response.Upload.URL = "https://objects.example.test/object"
	for _, difference := range []time.Duration{-time.Second, time.Second} {
		grantExpiry := expiry.Add(difference)
		response.Upload.ExpiresAt = grantExpiry.Format(time.RFC3339Nano)
		result, err := decodeFinalizedRenderObject(input, response)
		if err != nil {
			t.Fatal(err)
		}
		if result.Upload.ExpiresAt.After(expiry) || result.Upload.ExpiresAt.After(grantExpiry) {
			t.Fatal("upload exceeds a grant deadline")
		}
	}
	response.Upload.ExpiresAt = time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)
	if _, err := decodeFinalizedRenderObject(input, response); err == nil {
		t.Fatal("expired storage grant was accepted")
	}
}
