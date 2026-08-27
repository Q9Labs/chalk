package recorderworker

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjects"
)

func TestRecordingAuthorityClientUsesSeparateCredentialFreeUploader(t *testing.T) {
	expiresAt := time.Now().UTC().Add(10 * time.Minute).Format(time.RFC3339Nano)
	uploaded := make(chan []byte, 1)
	uploadServer := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.TLS == nil || len(request.TLS.PeerCertificates) != 0 {
			t.Errorf("upload received control-plane client certificate")
		}
		if request.Method != http.MethodPut || request.Header.Get("Content-Type") != "application/vnd.chalk.recording-bundle+json" || request.Header.Get("If-None-Match") != "*" {
			t.Errorf("upload request = method %s headers %v", request.Method, request.Header)
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read upload: %v", err)
		}
		uploaded <- body
		w.WriteHeader(http.StatusOK)
	}))
	uploadServer.TLS = &tls.Config{ClientAuth: tls.RequestClientCert, MinVersion: tls.VersionTLS13}
	uploadServer.StartTLS()
	defer uploadServer.Close()

	controlServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			t.Fatalf("control method = %s", request.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/internal/v1/recorder/keys/access":
			assertRecordingAuthorityRequest(t, request, "key_handle", recordingAuthorityClientKeyHandle)
			_ = json.NewEncoder(w).Encode(map[string]any{"key_handle": recordingAuthorityClientKeyHandle, "plaintext": base64.StdEncoding.EncodeToString(bytesOf(0x24)), "ciphertext_digest": strings.Repeat("ab", 32), "context_digest": strings.Repeat("cd", 32), "capture_epoch": 3})
		case "/internal/v1/recorder/bundles/reserve":
			assertRecordingAuthorityRequest(t, request, "object_handle", recordingAuthorityClientObjectHandle)
			_ = json.NewEncoder(w).Encode(map[string]any{"allocation_id": recordingAuthorityClientAllocationID, "object_key": "recordings/" + recordingAuthorityClientRecordingID + "/capture/3/bundles/12/" + recordingAuthorityClientAllocationID + ".bundle", "sequence_number": 12, "allocation_version": 13})
		case "/internal/v1/recorder/bundles/finalize":
			assertRecordingAuthorityRequest(t, request, "allocation_id", recordingAuthorityClientAllocationID)
			_ = json.NewEncoder(w).Encode(map[string]any{"allocation_id": recordingAuthorityClientAllocationID, "upload_token": "opaque-upload-token", "expires_at": expiresAt, "upload": map[string]any{"method": http.MethodPut, "url": uploadServer.URL + "/bundle", "expires_at": expiresAt, "signed_headers": map[string][]string{"Content-Type": {"application/vnd.chalk.recording-bundle+json"}, "If-None-Match": {"*"}}}})
		case "/internal/v1/recorder/bundles/commit":
			assertRecordingAuthorityRequest(t, request, "upload_token", "opaque-upload-token")
			_ = json.NewEncoder(w).Encode(map[string]any{"allocation_id": recordingAuthorityClientAllocationID, "object_key": "recordings/" + recordingAuthorityClientRecordingID + "/capture/3/bundles/12/" + recordingAuthorityClientAllocationID + ".bundle", "sequence_number": 12, "allocation_version": 13, "object_version": "r2-version", "object_etag": "etag", "object_checksum_sha256": strings.Repeat("ab", 32), "manifest_digest": "ef" + strings.Repeat("00", 31), "committed_at": time.Now().UTC().Format(time.RFC3339Nano)})
		default:
			http.NotFound(w, request)
		}
	}))
	defer controlServer.Close()

	controlHTTPClient := controlServer.Client()
	controlTransport := controlHTTPClient.Transport.(*http.Transport).Clone()
	controlTransport.TLSClientConfig.Certificates = append([]tls.Certificate(nil), uploadServer.TLS.Certificates...)
	controlHTTPClient.Transport = controlTransport
	client, err := NewControlPlaneClientWithUploader(controlServer.URL, controlHTTPClient, uploadServer.Client())
	if err != nil {
		t.Fatalf("new recording authority client: %v", err)
	}

	keyAuthority := recordingAuthorityClientKeyAuthority()
	key, err := client.AccessRecordingKey(context.Background(), keyAuthority)
	if err != nil {
		t.Fatalf("access key: %v", err)
	}
	if len(key.Plaintext) != 32 || key.KeyHandle != keyAuthority.KeyHandle || key.CaptureEpoch != keyAuthority.CaptureEpoch {
		t.Fatalf("key = %+v", key)
	}
	recordingkeys.ClearPlaintext(key.Plaintext)

	objectAuthority := recordingAuthorityClientObjectAuthority()
	contextDigest := bytesOf(0xcd)
	reservation, err := client.ReserveRecordingObject(context.Background(), recordingobjects.ReserveInput{Authority: objectAuthority, ReservationRequestID: recordingAuthorityClientReservationID, EncryptionContextDigest: contextDigest})
	if err != nil {
		t.Fatalf("reserve object: %v", err)
	}
	if reservation.SequenceNumber != 12 || reservation.AllocationVersion != 13 {
		t.Fatalf("reservation = %+v", reservation)
	}

	checksum := bytesOf(0xab)
	finalized, err := client.FinalizeRecordingObject(context.Background(), recordingobjects.FinalizeInput{Authority: objectAuthority, AllocationID: reservation.ID, ExpectedByteSize: 4, ExpectedChecksumSHA256: checksum, ContentType: "application/vnd.chalk.recording-bundle+json", Codec: "opus", MonotonicStartMillis: 0, MonotonicEndMillis: 10_000, MediaStartMillis: 0, MediaEndMillis: 10_000})
	if err != nil {
		t.Fatalf("finalize object: %v", err)
	}
	object := []byte{1, 2, 3, 4}
	if err := client.UploadRecordingObject(context.Background(), finalized.UploadURL, object); err != nil {
		t.Fatalf("upload object: %v", err)
	}
	if got := <-uploaded; string(got) != string(object) {
		t.Fatalf("uploaded bytes = %v", got)
	}

	manifestDigest := bytesOf(0xef)
	committed, err := client.CommitRecordingObject(context.Background(), recordingobjects.CommitInput{Authority: objectAuthority, AllocationID: reservation.ID, UploadToken: finalized.UploadToken, ManifestDigest: manifestDigest, MonotonicStartMillis: 0, MonotonicEndMillis: 10_000, MediaStartMillis: 0, MediaEndMillis: 10_000})
	if err != nil {
		if protocol, ok := err.(ProtocolError); ok {
			t.Fatalf("commit object: %v: %v", err, protocol.Err)
		}
		t.Fatalf("commit object: %v", err)
	}
	if committed.AllocationVersion != 13 || committed.ObjectVersion != "r2-version" || committed.SequenceNumber != 12 {
		t.Fatalf("committed = %+v", committed)
	}
}

func assertRecordingAuthorityRequest(t *testing.T, request *http.Request, key, value string) {
	t.Helper()
	var body map[string]any
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		t.Fatalf("decode control request: %v", err)
	}
	if body["lease_owner"] != recordingAuthorityClientWorkerID || body["lease_token"] != "lease-token" || body[key] != value {
		t.Fatalf("control authority = %v", body)
	}
}

const (
	recordingAuthorityClientWorkerID      = "11111111-1111-4111-8111-111111111111"
	recordingAuthorityClientTenantID      = "22222222-2222-4222-8222-222222222222"
	recordingAuthorityClientEpisodeID     = "33333333-3333-4333-8333-333333333333"
	recordingAuthorityClientRecordingID   = "44444444-4444-4444-8444-444444444444"
	recordingAuthorityClientJobID         = "55555555-5555-4555-8555-555555555555"
	recordingAuthorityClientKeyHandle     = "77777777-7777-4777-8777-777777777777"
	recordingAuthorityClientObjectHandle  = "88888888-8888-4888-8888-888888888888"
	recordingAuthorityClientReservationID = "99999999-9999-4999-8999-999999999999"
	recordingAuthorityClientAllocationID  = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
)

func recordingAuthorityClientKeyAuthority() recordingkeys.Authority {
	return recordingkeys.Authority{TenantID: recordingAuthorityClientTenantID, EpisodeID: recordingAuthorityClientEpisodeID, RecordingID: recordingAuthorityClientRecordingID, JobID: recordingAuthorityClientJobID, KeyHandle: recordingAuthorityClientKeyHandle, AttemptCount: 1, FencingGeneration: 2, CaptureEpoch: 3, EnvelopeDigest: bytesOf(0xab), LeaseToken: "lease-token", LeaseOwner: recordingAuthorityClientWorkerID, LeaseExpiresAt: time.Now().UTC().Add(time.Hour)}
}

func recordingAuthorityClientObjectAuthority() recordingobjects.Authority {
	key := recordingAuthorityClientKeyAuthority()
	return recordingobjects.Authority{TenantID: key.TenantID, EpisodeID: key.EpisodeID, RecordingID: key.RecordingID, JobID: key.JobID, ObjectHandle: recordingAuthorityClientObjectHandle, AttemptCount: key.AttemptCount, FencingGeneration: key.FencingGeneration, CaptureEpoch: key.CaptureEpoch, EnvelopeDigest: key.EnvelopeDigest, LeaseToken: key.LeaseToken, LeaseOwner: key.LeaseOwner, LeaseExpiresAt: key.LeaseExpiresAt}
}
