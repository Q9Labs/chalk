package recorderworker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjects"
)

const MaxRecordingObjectUploadBytes = 24 << 20

var ErrRecordingObjectUpload = errors.New("recording object upload failed")

type recorderRecordingAuthorityRequest struct {
	TenantID          string `json:"tenant_id"`
	EpisodeID         string `json:"episode_id"`
	RecordingID       string `json:"recording_id"`
	JobID             string `json:"job_id"`
	AttemptCount      int    `json:"attempt_count"`
	FencingGeneration int64  `json:"fencing_generation"`
	CaptureEpoch      int64  `json:"capture_epoch"`
	EnvelopeDigest    string `json:"envelope_digest"`
	LeaseToken        string `json:"lease_token"`
	LeaseOwner        string `json:"lease_owner"`
	LeaseExpiresAt    string `json:"lease_expires_at"`
}

type recorderRecordingKeyAccessRequest struct {
	recorderRecordingAuthorityRequest
	KeyHandle string `json:"key_handle"`
}

type recorderRecordingObjectAuthorityRequest struct {
	recorderRecordingAuthorityRequest
	ObjectHandle string `json:"object_handle"`
}

type recorderRecordingObjectReserveRequest struct {
	recorderRecordingObjectAuthorityRequest
	ReservationRequestID    string `json:"reservation_request_id"`
	EncryptionContextDigest string `json:"encryption_context_digest"`
}

type recorderRecordingObjectFinalizeRequest struct {
	recorderRecordingObjectAuthorityRequest
	AllocationID         string  `json:"allocation_id"`
	ByteSize             int64   `json:"byte_size"`
	ChecksumSHA256       string  `json:"checksum_sha256"`
	ContentType          string  `json:"content_type"`
	Codec                string  `json:"codec"`
	Layer                *string `json:"layer"`
	MonotonicStartMillis int64   `json:"monotonic_start_millis"`
	MonotonicEndMillis   int64   `json:"monotonic_end_millis"`
	MediaStartMillis     int64   `json:"media_start_millis"`
	MediaEndMillis       int64   `json:"media_end_millis"`
}

type recorderRecordingObjectCommitRequest struct {
	recorderRecordingObjectAuthorityRequest
	AllocationID         string `json:"allocation_id"`
	UploadToken          string `json:"upload_token"`
	ManifestDigest       string `json:"manifest_digest"`
	MonotonicStartMillis int64  `json:"monotonic_start_millis"`
	MonotonicEndMillis   int64  `json:"monotonic_end_millis"`
	MediaStartMillis     int64  `json:"media_start_millis"`
	MediaEndMillis       int64  `json:"media_end_millis"`
}

type recorderRecordingKeyAccessResponse struct {
	KeyHandle        string `json:"key_handle"`
	Plaintext        []byte `json:"plaintext"`
	CiphertextDigest string `json:"ciphertext_digest"`
	ContextDigest    string `json:"context_digest"`
	CaptureEpoch     int64  `json:"capture_epoch"`
}

type recorderRecordingObjectReserveResponse struct {
	AllocationID      string `json:"allocation_id"`
	ObjectKey         string `json:"object_key"`
	SequenceNumber    int64  `json:"sequence_number"`
	AllocationVersion int64  `json:"allocation_version"`
}

type recorderRecordingSignedUploadResponse struct {
	Method        string              `json:"method"`
	URL           string              `json:"url"`
	ExpiresAt     string              `json:"expires_at"`
	SignedHeaders map[string][]string `json:"signed_headers"`
}

type recorderRecordingObjectFinalizeResponse struct {
	AllocationID string                                `json:"allocation_id"`
	UploadToken  string                                `json:"upload_token"`
	Upload       recorderRecordingSignedUploadResponse `json:"upload"`
	ExpiresAt    string                                `json:"expires_at"`
}

type recorderRecordingObjectCommitResponse struct {
	AllocationID      string `json:"allocation_id"`
	ObjectKey         string `json:"object_key"`
	SequenceNumber    int64  `json:"sequence_number"`
	AllocationVersion int64  `json:"allocation_version"`
	ObjectVersion     string `json:"object_version"`
	ObjectETag        string `json:"object_etag"`
	ObjectChecksum    string `json:"object_checksum_sha256"`
	ManifestDigest    string `json:"manifest_digest"`
	CommittedAt       string `json:"committed_at"`
}

func (c *ControlPlaneClient) AccessRecordingKey(ctx context.Context, authority recordingkeys.Authority) (recordingkeys.DataKey, error) {
	if err := authority.Validate(); err != nil {
		return recordingkeys.DataKey{}, ErrInvalidControlPlaneRequest
	}
	request := recorderRecordingKeyAccessRequest{recorderRecordingAuthorityRequest: keyAuthorityRequest(authority), KeyHandle: authority.KeyHandle}
	body, _, err := c.do(ctx, http.MethodPost, "/internal/v1/recorder/keys/access", request, ControlPlaneResponseLimit)
	if err != nil {
		return recordingkeys.DataKey{}, err
	}
	defer clear(body)
	var response recorderRecordingKeyAccessResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingkeys.DataKey{}, ProtocolError{Err: err}
	}
	ciphertextDigest, cipherErr := decodeExactLowerHex(response.CiphertextDigest)
	contextDigest, contextErr := decodeExactLowerHex(response.ContextDigest)
	if cipherErr != nil || contextErr != nil || response.KeyHandle != authority.KeyHandle || response.CaptureEpoch != authority.CaptureEpoch || len(response.Plaintext) != 32 {
		clear(response.Plaintext)
		return recordingkeys.DataKey{}, ProtocolError{Err: errors.New("recording key response authority mismatch")}
	}
	return recordingkeys.DataKey{KeyHandle: response.KeyHandle, Plaintext: response.Plaintext, CiphertextDigest: ciphertextDigest, ContextDigest: contextDigest, CaptureEpoch: response.CaptureEpoch}, nil
}

func (c *ControlPlaneClient) ReserveRecordingObject(ctx context.Context, input recordingobjects.ReserveInput) (recordingobjects.Allocation, error) {
	if err := input.Validate(); err != nil {
		return recordingobjects.Allocation{}, ErrInvalidControlPlaneRequest
	}
	request := recorderRecordingObjectReserveRequest{recorderRecordingObjectAuthorityRequest: objectAuthorityRequest(input.Authority), ReservationRequestID: input.ReservationRequestID, EncryptionContextDigest: hex.EncodeToString(input.EncryptionContextDigest)}
	body, _, err := c.do(ctx, http.MethodPost, "/internal/v1/recorder/bundles/reserve", request, ControlPlaneResponseLimit)
	if err != nil {
		return recordingobjects.Allocation{}, err
	}
	var response recorderRecordingObjectReserveResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingobjects.Allocation{}, ProtocolError{Err: err}
	}
	if response.SequenceNumber < 0 || response.AllocationVersion <= 0 || response.AllocationID == "" || objectstorage.ValidateKey(response.ObjectKey) != nil {
		return recordingobjects.Allocation{}, ProtocolError{Err: errors.New("recording object reservation response")}
	}
	return recordingobjects.Allocation{ID: response.AllocationID, ReservationRequestID: input.ReservationRequestID, AllocationVersion: response.AllocationVersion, Authority: input.Authority, SequenceNumber: response.SequenceNumber, ObjectKey: response.ObjectKey, EncryptionContextDigest: append([]byte(nil), input.EncryptionContextDigest...), State: "reserved"}, nil
}

func (c *ControlPlaneClient) FinalizeRecordingObject(ctx context.Context, input recordingobjects.FinalizeInput) (recordingobjects.AllocationResult, error) {
	validation := input
	validation.ExpiresAt = time.Now().UTC().Add(recordingobjects.DefaultAllocationTTL)
	if err := validation.Validate(time.Now().UTC()); err != nil {
		return recordingobjects.AllocationResult{}, ErrInvalidControlPlaneRequest
	}
	request := recorderRecordingObjectFinalizeRequest{recorderRecordingObjectAuthorityRequest: objectAuthorityRequest(input.Authority), AllocationID: input.AllocationID, ByteSize: input.ExpectedByteSize, ChecksumSHA256: hex.EncodeToString(input.ExpectedChecksumSHA256), ContentType: input.ContentType, Codec: input.Codec, Layer: input.Layer, MonotonicStartMillis: input.MonotonicStartMillis, MonotonicEndMillis: input.MonotonicEndMillis, MediaStartMillis: input.MediaStartMillis, MediaEndMillis: input.MediaEndMillis}
	body, _, err := c.do(ctx, http.MethodPost, "/internal/v1/recorder/bundles/finalize", request, ControlPlaneResponseLimit)
	if err != nil {
		return recordingobjects.AllocationResult{}, err
	}
	var response recorderRecordingObjectFinalizeResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingobjects.AllocationResult{}, ProtocolError{Err: err}
	}
	expiresAt, expiryErr := parseRequiredTime(response.ExpiresAt)
	uploadExpiresAt, uploadExpiryErr := parseRequiredTime(response.Upload.ExpiresAt)
	uploadURL, urlErr := validateRecordingUploadURL(response.Upload.URL)
	if expiryErr != nil || uploadExpiryErr != nil || urlErr != nil || response.AllocationID != input.AllocationID || strings.TrimSpace(response.UploadToken) == "" || response.Upload.Method != http.MethodPut || !expiresAt.Equal(uploadExpiresAt) || !expiresAt.After(time.Now().UTC()) {
		return recordingobjects.AllocationResult{}, ProtocolError{Err: errors.New("recording object finalization response")}
	}
	return recordingobjects.AllocationResult{AllocationID: response.AllocationID, UploadToken: response.UploadToken, ExpiresAt: expiresAt, UploadURL: objectstorage.SignedURL{Method: response.Upload.Method, URL: uploadURL.String(), ExpiresAt: uploadExpiresAt, SignedHeader: cloneUploadHeaders(response.Upload.SignedHeaders)}}, nil
}

func (c *ControlPlaneClient) UploadRecordingObject(ctx context.Context, signed objectstorage.SignedURL, object []byte) error {
	if c == nil || c.uploader == nil || signed.Method != http.MethodPut || len(object) == 0 || len(object) > MaxRecordingObjectUploadBytes || !signed.ExpiresAt.After(time.Now().UTC()) {
		return ErrInvalidControlPlaneRequest
	}
	endpoint, err := validateRecordingUploadURL(signed.URL)
	if err != nil {
		return ErrInvalidControlPlaneRequest
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint.String(), bytes.NewReader(object))
	if err != nil {
		return ProtocolError{Err: err}
	}
	for name, values := range signed.SignedHeader {
		if strings.EqualFold(name, "Authorization") || strings.EqualFold(name, "Cookie") || strings.EqualFold(name, "Proxy-Authorization") || strings.EqualFold(name, "Host") || strings.EqualFold(name, "Content-Length") {
			return ErrInvalidControlPlaneRequest
		}
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	response, err := c.uploader.Do(request)
	if err != nil {
		return TransportError{Err: errors.Join(ErrRecordingObjectUpload, err)}
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("%w: %w", ErrRecordingObjectUpload, classifyHTTPError(response.StatusCode))
	}
	return nil
}

func (c *ControlPlaneClient) CommitRecordingObject(ctx context.Context, input recordingobjects.CommitInput) (recordingobjects.Bundle, error) {
	if err := input.Validate(); err != nil {
		return recordingobjects.Bundle{}, ErrInvalidControlPlaneRequest
	}
	request := recorderRecordingObjectCommitRequest{recorderRecordingObjectAuthorityRequest: objectAuthorityRequest(input.Authority), AllocationID: input.AllocationID, UploadToken: input.UploadToken, ManifestDigest: hex.EncodeToString(input.ManifestDigest), MonotonicStartMillis: input.MonotonicStartMillis, MonotonicEndMillis: input.MonotonicEndMillis, MediaStartMillis: input.MediaStartMillis, MediaEndMillis: input.MediaEndMillis}
	body, _, err := c.do(ctx, http.MethodPost, "/internal/v1/recorder/bundles/commit", request, ControlPlaneResponseLimit)
	if err != nil {
		return recordingobjects.Bundle{}, err
	}
	var response recorderRecordingObjectCommitResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingobjects.Bundle{}, ProtocolError{Err: err}
	}
	objectChecksum, checksumErr := decodeExactLowerHex(response.ObjectChecksum)
	manifestDigest, digestErr := decodeExactLowerHex(response.ManifestDigest)
	committedAt, timeErr := parseRequiredTime(response.CommittedAt)
	if checksumErr != nil {
		return recordingobjects.Bundle{}, ProtocolError{Err: errors.New("recording object commit checksum")}
	}
	if digestErr != nil || !bytes.Equal(manifestDigest, input.ManifestDigest) {
		return recordingobjects.Bundle{}, ProtocolError{Err: errors.New("recording object commit manifest digest")}
	}
	if timeErr != nil {
		return recordingobjects.Bundle{}, ProtocolError{Err: errors.New("recording object commit time")}
	}
	if response.AllocationID != input.AllocationID || response.SequenceNumber < 0 || response.AllocationVersion <= 0 {
		return recordingobjects.Bundle{}, ProtocolError{Err: errors.New("recording object commit allocation authority")}
	}
	if response.ObjectVersion == "" || response.ObjectETag == "" || objectstorage.ValidateKey(response.ObjectKey) != nil {
		return recordingobjects.Bundle{}, ProtocolError{Err: errors.New("recording object commit provider facts")}
	}
	allocation := recordingobjects.Allocation{ID: response.AllocationID, AllocationVersion: response.AllocationVersion, Authority: input.Authority, SequenceNumber: response.SequenceNumber, ObjectKey: response.ObjectKey, ObjectVersion: response.ObjectVersion, ObjectETag: response.ObjectETag, ObjectChecksumSHA256: objectChecksum, ManifestDigest: manifestDigest, CommittedAt: &committedAt, State: "committed"}
	return recordingobjects.Bundle{Allocation: allocation, ManifestDigest: manifestDigest, ObjectVersion: response.ObjectVersion, ObjectETag: response.ObjectETag, ObjectChecksumSHA256: objectChecksum, CommittedAt: committedAt}, nil
}

func keyAuthorityRequest(authority recordingkeys.Authority) recorderRecordingAuthorityRequest {
	return recorderRecordingAuthorityRequest{TenantID: authority.TenantID, EpisodeID: authority.EpisodeID, RecordingID: authority.RecordingID, JobID: authority.JobID, AttemptCount: authority.AttemptCount, FencingGeneration: authority.FencingGeneration, CaptureEpoch: authority.CaptureEpoch, EnvelopeDigest: hex.EncodeToString(authority.EnvelopeDigest), LeaseToken: authority.LeaseToken, LeaseOwner: authority.LeaseOwner, LeaseExpiresAt: authority.LeaseExpiresAt.UTC().Format(time.RFC3339Nano)}
}

func objectAuthorityRequest(authority recordingobjects.Authority) recorderRecordingObjectAuthorityRequest {
	return recorderRecordingObjectAuthorityRequest{recorderRecordingAuthorityRequest: recorderRecordingAuthorityRequest{TenantID: authority.TenantID, EpisodeID: authority.EpisodeID, RecordingID: authority.RecordingID, JobID: authority.JobID, AttemptCount: authority.AttemptCount, FencingGeneration: authority.FencingGeneration, CaptureEpoch: authority.CaptureEpoch, EnvelopeDigest: hex.EncodeToString(authority.EnvelopeDigest), LeaseToken: authority.LeaseToken, LeaseOwner: authority.LeaseOwner, LeaseExpiresAt: authority.LeaseExpiresAt.UTC().Format(time.RFC3339Nano)}, ObjectHandle: authority.ObjectHandle}
}

func validateRecordingUploadURL(value string) (*url.URL, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return nil, errors.New("invalid recording upload URL")
	}
	return parsed, nil
}

func decodeExactLowerHex(value string) ([]byte, error) {
	if value != strings.ToLower(value) {
		return nil, errors.New("digest is not canonical")
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size {
		return nil, errors.New("invalid digest")
	}
	return decoded, nil
}

func cloneUploadHeaders(headers map[string][]string) map[string][]string {
	cloned := make(map[string][]string, len(headers))
	for name, values := range headers {
		cloned[name] = append([]string(nil), values...)
	}
	return cloned
}
