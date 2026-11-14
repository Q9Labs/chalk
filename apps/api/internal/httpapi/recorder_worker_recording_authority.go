package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recorderprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjects"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

const (
	recordingBundleContentType       = "application/vnd.chalk.recording-bundle"
	legacyRecordingBundleContentType = "application/vnd.chalk.recording-bundle+json"
)

type RecorderRecordingKeyService interface {
	GetOrCreate(context.Context, recordingkeys.Authority) (recordingkeys.DataKey, error)
}

type RecorderRecordingObjectService interface {
	Reserve(context.Context, recordingobjects.ReserveInput) (recordingobjects.Allocation, error)
	Finalize(context.Context, recordingobjects.FinalizeInput) (recordingobjects.AllocationResult, error)
	Commit(context.Context, recordingobjects.CommitInput) (recordingobjects.Bundle, error)
}

func mountRecorderRecordingAuthorityRoutes(r chi.Router, keys RecorderRecordingKeyService, objects RecorderRecordingObjectService) {
	if keys != nil {
		r.Post(string(recorderprotocol.RouteKeysAccess), recorderRecordingKeyAccessHandler(keys))
	}
	if objects != nil {
		r.Post(string(recorderprotocol.RouteBundlesReserve), recorderRecordingObjectReserveHandler(objects))
		r.Post(string(recorderprotocol.RouteBundlesFinalize), recorderRecordingObjectFinalizeHandler(objects))
		r.Post(string(recorderprotocol.RouteBundlesCommit), recorderRecordingObjectCommitHandler(objects))
	}
}

func recorderRecordingKeyAccessHandler(service RecorderRecordingKeyService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Pragma", "no-cache")
		identity, ok := recorderCaptureIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderprotocol.RecordingKeyAccessRequest](w, request)
		if !ok {
			return
		}
		authority, ok := recordingKeyAuthority(identity, body)
		if !ok {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recording key request")
			return
		}
		key, err := service.GetOrCreate(request.Context(), authority)
		if err != nil {
			writeRecorderRecordingAuthorityError(w, err)
			return
		}
		defer recordingkeys.ClearPlaintext(key.Plaintext)
		writeJSON(w, http.StatusOK, recorderprotocol.RecordingKeyAccessResponse{
			KeyHandle: key.KeyHandle, Plaintext: base64.StdEncoding.EncodeToString(key.Plaintext),
			CiphertextDigest: hex.EncodeToString(key.CiphertextDigest), ContextDigest: hex.EncodeToString(key.ContextDigest), CaptureEpoch: key.CaptureEpoch,
		})
	}
}

func recorderRecordingObjectReserveHandler(service RecorderRecordingObjectService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderCaptureIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderprotocol.RecordingObjectReserveRequest](w, request)
		if !ok {
			return
		}
		authority, valid := recordingObjectAuthority(identity, body.RecordingObjectAuthority)
		digest, digestErr := decodeSHA256Hex(body.EncryptionContextDigest)
		if !valid || digestErr != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recording object reservation")
			return
		}
		allocation, err := service.Reserve(request.Context(), recordingobjects.ReserveInput{Authority: authority, ReservationRequestID: body.ReservationRequestID, EncryptionContextDigest: digest})
		if err != nil {
			writeRecorderRecordingAuthorityError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, recorderprotocol.RecordingObjectReserveResponse{AllocationID: allocation.ID, ObjectKey: allocation.ObjectKey, SequenceNumber: allocation.SequenceNumber, AllocationVersion: allocation.AllocationVersion})
	}
}

func recorderRecordingObjectFinalizeHandler(service RecorderRecordingObjectService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderCaptureIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderprotocol.RecordingObjectFinalizeRequest](w, request)
		if !ok {
			return
		}
		authority, valid := recordingObjectAuthority(identity, body.RecordingObjectAuthority)
		checksum, checksumErr := decodeSHA256Hex(body.ChecksumSHA256)
		if !valid || checksumErr != nil || (strings.TrimSpace(body.ContentType) != recordingBundleContentType && strings.TrimSpace(body.ContentType) != legacyRecordingBundleContentType) {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recording object finalization")
			return
		}
		result, err := service.Finalize(request.Context(), recordingobjects.FinalizeInput{
			Authority: authority, AllocationID: body.AllocationID, ExpectedByteSize: body.ByteSize, ExpectedChecksumSHA256: checksum,
			ContentType: body.ContentType, Codec: body.Codec, Layer: body.Layer, MonotonicStartMillis: body.MonotonicStartMillis,
			MonotonicEndMillis: body.MonotonicEndMillis, MediaStartMillis: body.MediaStartMillis, MediaEndMillis: body.MediaEndMillis,
		})
		if err != nil {
			writeRecorderRecordingAuthorityError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, recorderprotocol.RecordingObjectFinalizeResponse{
			AllocationID: result.AllocationID, UploadToken: result.UploadToken, ExpiresAt: utilities.FormatTimestamp(result.ExpiresAt),
			Upload: recorderprotocol.SignedUploadResponse{Method: result.UploadURL.Method, URL: result.UploadURL.URL, ExpiresAt: utilities.FormatTimestamp(result.UploadURL.ExpiresAt), SignedHeaders: cloneSignedHeaders(result.UploadURL)},
		})
	}
}

func recorderRecordingObjectCommitHandler(service RecorderRecordingObjectService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderCaptureIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderprotocol.RecordingObjectCommitRequest](w, request)
		if !ok {
			return
		}
		authority, valid := recordingObjectAuthority(identity, body.RecordingObjectAuthority)
		manifestDigest, digestErr := decodeSHA256Hex(body.ManifestDigest)
		if !valid || digestErr != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recording object commit")
			return
		}
		bundle, err := service.Commit(request.Context(), recordingobjects.CommitInput{
			Authority: authority, AllocationID: body.AllocationID, UploadToken: body.UploadToken, ManifestDigest: manifestDigest,
			MonotonicStartMillis: body.MonotonicStartMillis, MonotonicEndMillis: body.MonotonicEndMillis,
			MediaStartMillis: body.MediaStartMillis, MediaEndMillis: body.MediaEndMillis,
		})
		if err != nil {
			writeRecorderRecordingAuthorityError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, recorderprotocol.RecordingObjectCommitResponse{
			AllocationID: bundle.ID, ObjectKey: bundle.ObjectKey, SequenceNumber: bundle.SequenceNumber,
			AllocationVersion: bundle.AllocationVersion, ObjectVersion: bundle.ObjectVersion, ObjectETag: bundle.ObjectETag,
			ObjectChecksum: hex.EncodeToString(bundle.ObjectChecksumSHA256), ManifestDigest: hex.EncodeToString(bundle.ManifestDigest), CommittedAt: utilities.FormatTimestamp(bundle.CommittedAt),
		})
	}
}

func recorderCaptureIdentity(w http.ResponseWriter, request *http.Request) (workeridentity.Identity, bool) {
	identity, ok := recorderWorkerRequestIdentity(w, request)
	if !ok {
		return workeridentity.Identity{}, false
	}
	if identity.Role != workeridentity.RoleCapture {
		writeError(w, http.StatusForbidden, recorderprotocol.CodeWorkerForbidden, "Only capture workers may access recording authority")
		return workeridentity.Identity{}, false
	}
	return identity, true
}

func recordingKeyAuthority(identity workeridentity.Identity, body recorderprotocol.RecordingKeyAccessRequest) (recordingkeys.Authority, bool) {
	base, ok := parseRecorderRecordingAuthority(identity, body.RecordingAuthority)
	keyHandle, keyErr := utilities.ParseID(body.KeyHandle)
	if !ok || keyErr != nil {
		return recordingkeys.Authority{}, false
	}
	return recordingkeys.Authority{TenantID: base.tenantID, EpisodeID: base.episodeID, RecordingID: base.recordingID, JobID: base.jobID, KeyHandle: keyHandle.String(), AttemptCount: base.attemptCount, FencingGeneration: base.fencingGeneration, CaptureEpoch: base.captureEpoch, EnvelopeDigest: base.envelopeDigest, LeaseToken: base.leaseToken, LeaseOwner: base.leaseOwner, LeaseExpiresAt: base.leaseExpiresAt}, true
}

func recordingObjectAuthority(identity workeridentity.Identity, body recorderprotocol.RecordingObjectAuthority) (recordingobjects.Authority, bool) {
	base, ok := parseRecorderRecordingAuthority(identity, body.RecordingAuthority)
	objectHandle, objectErr := utilities.ParseID(body.ObjectHandle)
	if !ok || objectErr != nil {
		return recordingobjects.Authority{}, false
	}
	return recordingobjects.Authority{TenantID: base.tenantID, EpisodeID: base.episodeID, RecordingID: base.recordingID, JobID: base.jobID, ObjectHandle: objectHandle.String(), AttemptCount: base.attemptCount, FencingGeneration: base.fencingGeneration, CaptureEpoch: base.captureEpoch, EnvelopeDigest: base.envelopeDigest, LeaseToken: base.leaseToken, LeaseOwner: base.leaseOwner, LeaseExpiresAt: base.leaseExpiresAt}, true
}

type parsedRecorderRecordingAuthority struct {
	tenantID, episodeID, recordingID, jobID string
	attemptCount                            int
	fencingGeneration, captureEpoch         int64
	envelopeDigest                          []byte
	leaseToken, leaseOwner                  string
	leaseExpiresAt                          time.Time
}

func parseRecorderRecordingAuthority(identity workeridentity.Identity, body recorderprotocol.RecordingAuthority) (parsedRecorderRecordingAuthority, bool) {
	tenantID, tenantErr := utilities.ParseID(body.TenantID)
	episodeID, episodeErr := utilities.ParseID(body.EpisodeID)
	recordingID, recordingErr := utilities.ParseID(body.RecordingID)
	jobID, jobErr := utilities.ParseID(body.JobID)
	digest, digestErr := decodeEnvelopeDigest(body.EnvelopeDigest)
	expiresAt, expiryErr := time.Parse(time.RFC3339Nano, body.LeaseExpiresAt)
	wantOwner := recorderWorkerLeaseOwner(identity)
	if tenantErr != nil || episodeErr != nil || recordingErr != nil || jobErr != nil || digestErr != nil || expiryErr != nil || body.AttemptCount <= 0 || body.FencingGeneration <= 0 || body.CaptureEpoch <= 0 || strings.TrimSpace(body.LeaseToken) == "" || body.LeaseOwner != wantOwner || !expiresAt.After(time.Now().UTC()) {
		return parsedRecorderRecordingAuthority{}, false
	}
	return parsedRecorderRecordingAuthority{tenantID: tenantID.String(), episodeID: episodeID.String(), recordingID: recordingID.String(), jobID: jobID.String(), attemptCount: body.AttemptCount, fencingGeneration: body.FencingGeneration, captureEpoch: body.CaptureEpoch, envelopeDigest: digest, leaseToken: body.LeaseToken, leaseOwner: wantOwner, leaseExpiresAt: expiresAt.UTC()}, true
}

func decodeSHA256Hex(value string) ([]byte, error) {
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size || value != strings.ToLower(value) {
		return nil, errors.New("invalid sha256 digest")
	}
	return decoded, nil
}

func writeRecorderRecordingAuthorityError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, recordingkeys.ErrInvalidRequest), errors.Is(err, recordingobjects.ErrInvalidRequest):
		writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recording authority request")
	case errors.Is(err, recordingkeys.ErrAuthorityMismatch), errors.Is(err, recordingobjects.ErrAuthorityMismatch), errors.Is(err, recordingobjects.ErrAllocationExpired):
		writeError(w, http.StatusConflict, "lease.stale", "Recording authority is stale or unavailable")
	case errors.Is(err, recordingobjects.ErrAllocationConflict):
		writeError(w, http.StatusConflict, "bundle.conflict", "Recording bundle allocation conflicts with an existing request")
	case errors.Is(err, recordingkeys.ErrKeyNotFound), errors.Is(err, recordingobjects.ErrAllocationNotFound):
		writeError(w, http.StatusNotFound, "recording.not_found", "Recording authority resource was not found")
	case errors.Is(err, recordingobjects.ErrObjectFactsMismatch):
		writeError(w, http.StatusPreconditionFailed, "bundle.object_mismatch", "Uploaded recording bundle does not match its allocation")
	case errors.Is(err, recordingkeys.ErrKMSUnavailable), errors.Is(err, recordingkeys.ErrRepositoryUnavailable), errors.Is(err, recordingobjects.ErrRepositoryUnavailable), errors.Is(err, recordingobjects.ErrStorageUnavailable), errors.Is(err, objectstorage.ErrStoreUnavailable):
		writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Recording authority service is unavailable")
	case errors.Is(err, recordingkeys.ErrKMSFailed), errors.Is(err, objectstorage.ErrProviderFailed):
		writeError(w, http.StatusBadGateway, "provider.failed", "Recording authority provider failed")
	default:
		writeError(w, http.StatusInternalServerError, "internal.error", "Recording authority operation failed")
	}
}

var _ RecorderRecordingKeyService = recordingkeys.Service{}
var _ RecorderRecordingObjectService = recordingobjects.Service{}
