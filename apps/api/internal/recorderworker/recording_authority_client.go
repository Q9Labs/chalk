package recorderworker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recorderprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjects"
)

const MaxRecordingObjectUploadBytes = 24 << 20

var ErrRecordingObjectUpload = errors.New("recording object upload failed")

func (c *ControlPlaneClient) AccessRecordingKey(ctx context.Context, authority recordingkeys.Authority) (recordingkeys.DataKey, error) {
	if err := authority.Validate(); err != nil {
		return recordingkeys.DataKey{}, ErrInvalidControlPlaneRequest
	}
	request := recorderprotocol.RecordingKeyAccessRequest{RecordingAuthority: keyAuthorityRequest(authority), KeyHandle: authority.KeyHandle}
	body, _, err := c.do(ctx, http.MethodPost, recorderprotocol.RouteKeysAccess.Path(), request, ControlPlaneResponseLimit)
	if err != nil {
		return recordingkeys.DataKey{}, err
	}
	defer clear(body)
	var response recorderprotocol.RecordingKeyAccessResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingkeys.DataKey{}, ProtocolError{Err: err}
	}
	ciphertextDigest, cipherErr := decodeExactLowerHex(response.CiphertextDigest)
	contextDigest, contextErr := decodeExactLowerHex(response.ContextDigest)
	plaintext, plaintextErr := base64.StdEncoding.DecodeString(response.Plaintext)
	if cipherErr != nil || contextErr != nil || plaintextErr != nil || response.KeyHandle != authority.KeyHandle || response.CaptureEpoch != authority.CaptureEpoch || len(plaintext) != 32 {
		clear(plaintext)
		return recordingkeys.DataKey{}, ProtocolError{Err: errors.New("recording key response authority mismatch")}
	}
	return recordingkeys.DataKey{KeyHandle: response.KeyHandle, Plaintext: plaintext, CiphertextDigest: ciphertextDigest, ContextDigest: contextDigest, CaptureEpoch: response.CaptureEpoch}, nil
}

func (c *ControlPlaneClient) ReserveRecordingObject(ctx context.Context, input recordingobjects.ReserveInput) (recordingobjects.Allocation, error) {
	if err := input.Validate(); err != nil {
		return recordingobjects.Allocation{}, ErrInvalidControlPlaneRequest
	}
	request := recorderprotocol.RecordingObjectReserveRequest{RecordingObjectAuthority: objectAuthorityRequest(input.Authority), ReservationRequestID: input.ReservationRequestID, EncryptionContextDigest: hex.EncodeToString(input.EncryptionContextDigest)}
	body, _, err := c.do(ctx, http.MethodPost, recorderprotocol.RouteBundlesReserve.Path(), request, ControlPlaneResponseLimit)
	if err != nil {
		return recordingobjects.Allocation{}, err
	}
	var response recorderprotocol.RecordingObjectReserveResponse
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
	request := recorderprotocol.RecordingObjectFinalizeRequest{RecordingObjectAuthority: objectAuthorityRequest(input.Authority), AllocationID: input.AllocationID, ByteSize: input.ExpectedByteSize, ChecksumSHA256: hex.EncodeToString(input.ExpectedChecksumSHA256), ContentType: input.ContentType, Codec: input.Codec, Layer: input.Layer, MonotonicStartMillis: input.MonotonicStartMillis, MonotonicEndMillis: input.MonotonicEndMillis, MediaStartMillis: input.MediaStartMillis, MediaEndMillis: input.MediaEndMillis}
	body, _, err := c.do(ctx, http.MethodPost, recorderprotocol.RouteBundlesFinalize.Path(), request, ControlPlaneResponseLimit)
	if err != nil {
		return recordingobjects.AllocationResult{}, err
	}
	var response recorderprotocol.RecordingObjectFinalizeResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingobjects.AllocationResult{}, ProtocolError{Err: err}
	}
	expiresAt, expiryErr := parseRequiredTime(response.ExpiresAt)
	uploadExpiresAt, uploadExpiryErr := parseRequiredTime(response.Upload.ExpiresAt)
	uploadURL, urlErr := validateRecordingUploadURL(response.Upload.URL)
	if expiryErr != nil || uploadExpiryErr != nil || urlErr != nil || response.AllocationID != input.AllocationID || strings.TrimSpace(response.UploadToken) == "" || response.Upload.Method != http.MethodPut || !uploadExpiresAt.After(time.Now().UTC()) || !expiresAt.After(time.Now().UTC()) {
		return recordingobjects.AllocationResult{}, ProtocolError{Err: errors.New("recording object finalization response")}
	}
	// Allocation and storage grants have independent signing clocks. Uploads
	// must stop at whichever deadline arrives first.
	if uploadExpiresAt.After(expiresAt) {
		uploadExpiresAt = expiresAt
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
	request := recorderprotocol.RecordingObjectCommitRequest{RecordingObjectAuthority: objectAuthorityRequest(input.Authority), AllocationID: input.AllocationID, UploadToken: input.UploadToken, ManifestDigest: hex.EncodeToString(input.ManifestDigest), MonotonicStartMillis: input.MonotonicStartMillis, MonotonicEndMillis: input.MonotonicEndMillis, MediaStartMillis: input.MediaStartMillis, MediaEndMillis: input.MediaEndMillis}
	body, _, err := c.do(ctx, http.MethodPost, recorderprotocol.RouteBundlesCommit.Path(), request, ControlPlaneResponseLimit)
	if err != nil {
		return recordingobjects.Bundle{}, err
	}
	var response recorderprotocol.RecordingObjectCommitResponse
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
	if response.ObjectETag == "" || objectstorage.ValidateKey(response.ObjectKey) != nil {
		return recordingobjects.Bundle{}, ProtocolError{Err: errors.New("recording object commit provider facts")}
	}
	allocation := recordingobjects.Allocation{ID: response.AllocationID, AllocationVersion: response.AllocationVersion, Authority: input.Authority, SequenceNumber: response.SequenceNumber, ObjectKey: response.ObjectKey, ObjectVersion: response.ObjectVersion, ObjectETag: response.ObjectETag, ObjectChecksumSHA256: objectChecksum, ManifestDigest: manifestDigest, CommittedAt: &committedAt, State: "committed"}
	return recordingobjects.Bundle{Allocation: allocation, ManifestDigest: manifestDigest, ObjectVersion: response.ObjectVersion, ObjectETag: response.ObjectETag, ObjectChecksumSHA256: objectChecksum, CommittedAt: committedAt}, nil
}

func keyAuthorityRequest(authority recordingkeys.Authority) recorderprotocol.RecordingAuthority {
	return recorderprotocol.RecordingAuthority{TenantID: authority.TenantID, EpisodeID: authority.EpisodeID, RecordingID: authority.RecordingID, JobID: authority.JobID, AttemptCount: authority.AttemptCount, FencingGeneration: authority.FencingGeneration, CaptureEpoch: authority.CaptureEpoch, EnvelopeDigest: hex.EncodeToString(authority.EnvelopeDigest), LeaseToken: authority.LeaseToken, LeaseOwner: authority.LeaseOwner, LeaseExpiresAt: authority.LeaseExpiresAt.UTC().Format(time.RFC3339Nano)}
}

func objectAuthorityRequest(authority recordingobjects.Authority) recorderprotocol.RecordingObjectAuthority {
	return recorderprotocol.RecordingObjectAuthority{RecordingAuthority: recorderprotocol.RecordingAuthority{TenantID: authority.TenantID, EpisodeID: authority.EpisodeID, RecordingID: authority.RecordingID, JobID: authority.JobID, AttemptCount: authority.AttemptCount, FencingGeneration: authority.FencingGeneration, CaptureEpoch: authority.CaptureEpoch, EnvelopeDigest: hex.EncodeToString(authority.EnvelopeDigest), LeaseToken: authority.LeaseToken, LeaseOwner: authority.LeaseOwner, LeaseExpiresAt: authority.LeaseExpiresAt.UTC().Format(time.RFC3339Nano)}, ObjectHandle: authority.ObjectHandle}
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
