package recordingrender

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type Config struct {
	KeyID    string
	GrantTTL time.Duration
	Now      func() time.Time
	Wake     DispatcherWake
}

type Service struct {
	objects    objectstorage.Service
	kms        recordingkeys.KMS
	repository Repository
	keyID      string
	grantTTL   time.Duration
	now        func() time.Time
	wake       DispatcherWake
}

func NewService(objects objectstorage.Service, kms recordingkeys.KMS, repository Repository, config Config) (Service, error) {
	if repository == nil {
		return Service{}, ErrRepositoryUnavailable
	}
	if kms == nil || strings.TrimSpace(config.KeyID) == "" {
		return Service{}, ErrKMSUnavailable
	}
	if config.GrantTTL <= 0 {
		config.GrantTTL = DefaultGrantTTL
	}
	if config.GrantTTL > MaximumGrantTTL {
		return Service{}, ErrInvalidRequest
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return Service{objects: objects, kms: kms, repository: repository, keyID: strings.TrimSpace(config.KeyID), grantTTL: config.GrantTTL, now: config.Now, wake: config.Wake}, nil
}

func (s Service) ResolveRenderInput(ctx context.Context, authority Authority) (ResolvedInput, error) {
	if err := authority.Validate(); err != nil {
		return ResolvedInput{}, err
	}
	now := s.now().UTC()
	stored, err := s.repository.ResolveInput(ctx, authority)
	if err != nil {
		return ResolvedInput{}, err
	}
	if stored.SchemaVersion != InputSchemaVersion || !SameAuthority(stored.Authority, authority) {
		return ResolvedInput{}, ErrAuthorityMismatch
	}
	if err := validateStoredInput(stored); err != nil {
		return ResolvedInput{}, err
	}
	expiresAt, err := uploadExpiry(now, authority, s.grantTTL)
	if err != nil {
		return ResolvedInput{}, err
	}
	if !stored.SourceExpiresAt.IsZero() && stored.SourceExpiresAt.Before(expiresAt) {
		expiresAt = stored.SourceExpiresAt.UTC()
	}
	if !expiresAt.After(now) {
		return ResolvedInput{}, ErrLeaseStale
	}

	resolved := ResolvedInput{
		SchemaVersion:     InputSchemaVersion,
		TranscriptionMode: stored.TranscriptionMode,
		TenantID:          authority.TenantID, SpaceID: authority.SpaceID, EpisodeID: authority.EpisodeID,
		RecordingID: authority.RecordingID, CaptureEpoch: authority.CaptureEpoch,
		CaptureReadyAt: stored.Presentation.CaptureReadyAt, DurationMillis: stored.Presentation.DurationMillis,
		PresentationHandle: stored.Presentation.Handle, PresentationSchemaVersion: stored.Presentation.SchemaVersion,
		PresentationProfileVersion: stored.Presentation.ProfileVersion, PresentationSHA256: append([]byte(nil), stored.Presentation.SHA256...),
		Capture: make([]DownloadableCaptureObject, 0, len(stored.Capture)),
		Assets:  make([]DownloadableObject, 0, len(stored.Presentation.Assets)),
	}
	for _, captureObject := range stored.Capture {
		download, err := s.download(ctx, captureObject.ObjectFacts, expiresAt, "")
		if err != nil {
			return ResolvedInput{}, fmt.Errorf("sign capture object download: %w", err)
		}
		resolved.Capture = append(resolved.Capture, DownloadableCaptureObject{CaptureObject: cloneCaptureObject(captureObject), Download: download})
	}
	resolved.Presentation, err = s.downloadable(ctx, stored.Presentation.Object, expiresAt)
	if err != nil {
		return ResolvedInput{}, fmt.Errorf("sign presentation download: %w", err)
	}
	resolved.AssetManifest, err = s.downloadable(ctx, stored.Presentation.AssetManifest, expiresAt)
	if err != nil {
		return ResolvedInput{}, fmt.Errorf("sign asset manifest download: %w", err)
	}
	for _, asset := range stored.Presentation.Assets {
		downloadable, err := s.downloadable(ctx, asset, expiresAt)
		if err != nil {
			return ResolvedInput{}, fmt.Errorf("sign presentation asset download: %w", err)
		}
		resolved.Assets = append(resolved.Assets, downloadable)
	}
	return resolved, nil
}

func (s Service) AccessRenderKey(ctx context.Context, input AccessKeyInput) (DataKey, error) {
	if err := input.Validate(); err != nil {
		return DataKey{}, err
	}
	encrypted, err := s.repository.GetCaptureKey(ctx, input)
	if err != nil {
		return DataKey{}, err
	}
	if encrypted.KeyHandle.IsZero() || encrypted.Context.CaptureEpoch != input.CaptureEpoch || encrypted.Context.RecordingID != input.Authority.RecordingID.String() {
		return DataKey{}, ErrAuthorityMismatch
	}
	plaintext, err := s.kms.Decrypt(ctx, s.keyID, encrypted.CiphertextBlob, encrypted.Context.Map())
	if err != nil {
		return DataKey{}, fmt.Errorf("decrypt recording render key: %w", err)
	}
	if len(plaintext) != 32 {
		recordingkeys.ClearPlaintext(plaintext)
		return DataKey{}, recordingkeys.ErrPlaintextInvalid
	}
	return DataKey{KeyHandle: encrypted.KeyHandle, Plaintext: plaintext, CaptureEpoch: input.CaptureEpoch}, nil
}

func (s Service) ReserveRenderObject(ctx context.Context, input ReserveObjectInput) (ReservedObject, error) {
	if err := input.Validate(); err != nil {
		return ReservedObject{}, err
	}
	allocationID, err := utilities.NewID()
	if err != nil {
		return ReservedObject{}, fmt.Errorf("generate render allocation id: %w", err)
	}
	objectKey := renderObjectKey(input.Authority, input.Purpose, allocationID)
	if err := objectstorage.ValidateKey(objectKey); err != nil {
		return ReservedObject{}, fmt.Errorf("generate render object key: %w", err)
	}
	allocation, err := s.repository.ReserveObject(ctx, input, allocationID, objectKey, s.now().UTC())
	if err != nil {
		return ReservedObject{}, err
	}
	return ReservedObject{AllocationID: allocation.ID, ObjectKey: allocation.Object.ObjectKey, Purpose: allocation.Purpose, AllocationVersion: allocation.AllocationVersion}, nil
}

func (s Service) FinalizeRenderObject(ctx context.Context, input FinalizeObjectInput) (FinalizedObject, error) {
	if err := input.Validate(); err != nil {
		return FinalizedObject{}, err
	}
	allocation, err := s.repository.GetObjectAllocation(ctx, input.Authority, input.AllocationID)
	if err != nil {
		return FinalizedObject{}, err
	}
	if !SameAuthority(allocation.Authority, input.Authority) || allocation.Purpose != input.Purpose {
		return FinalizedObject{}, ErrAuthorityMismatch
	}
	if allocation.State != "reserved" && allocation.State != "allocated" {
		return FinalizedObject{}, ErrAllocationConflict
	}
	if allocation.State == "allocated" && !sameFinalization(allocation, input) {
		return FinalizedObject{}, ErrAllocationConflict
	}
	now := s.now().UTC()
	expiresAt, err := uploadExpiry(now, input.Authority, s.grantTTL)
	if err != nil {
		return FinalizedObject{}, err
	}
	token, err := opaqueToken()
	if err != nil {
		return FinalizedObject{}, fmt.Errorf("generate render upload token: %w", err)
	}
	allocation.State = "allocated"
	allocation.ExpectedContentType = input.ContentType
	allocation.ExpectedByteSize = input.ByteSize
	allocation.ExpectedSHA256 = append([]byte(nil), input.SHA256...)
	allocation.ExpectedDurationMillis = cloneInt64(input.DurationMillis)
	allocation.UploadTokenHash = tokenHash(token)
	allocation.UploadExpiresAt = &expiresAt
	upload, err := s.objects.CreateUploadURL(ctx, objectstorage.CreateUploadURLInput{
		Key: allocation.Object.ObjectKey, ContentType: input.ContentType, ContentLength: input.ByteSize,
		ChecksumSHA256: base64.StdEncoding.EncodeToString(input.SHA256), ExpiresIn: expiresAt.Sub(now), IfNoneMatch: true,
		Metadata: map[string]string{"chalk-allocation-id": allocation.ID.String(), "chalk-purpose": string(input.Purpose), "chalk-sha256": hex.EncodeToString(input.SHA256)},
	})
	if err != nil {
		return FinalizedObject{}, fmt.Errorf("sign render object upload: %w", err)
	}
	allocation, err = s.repository.FinalizeObject(ctx, allocation)
	if err != nil {
		return FinalizedObject{}, err
	}
	return FinalizedObject{
		ReservedObject: ReservedObject{AllocationID: allocation.ID, ObjectKey: allocation.Object.ObjectKey, Purpose: allocation.Purpose, AllocationVersion: allocation.AllocationVersion},
		UploadToken:    token, Upload: upload, ExpiresAt: expiresAt,
	}, nil
}

func (s Service) CommitRenderObject(ctx context.Context, input CommitObjectInput) (CommittedObject, error) {
	if err := input.Validate(); err != nil {
		return CommittedObject{}, err
	}
	allocation, err := s.repository.GetObjectAllocationByTokenHash(ctx, input.Authority, tokenHash(input.UploadToken))
	if err != nil {
		return CommittedObject{}, err
	}
	if allocation.ID != input.AllocationID || !SameAuthority(allocation.Authority, input.Authority) {
		return CommittedObject{}, ErrAuthorityMismatch
	}
	if allocation.State != "allocated" && allocation.State != "committed" {
		return CommittedObject{}, ErrAllocationConflict
	}
	if allocation.UploadExpiresAt == nil || (allocation.State != "committed" && !allocation.UploadExpiresAt.After(s.now().UTC())) {
		return CommittedObject{}, ErrAllocationExpired
	}
	facts, err := s.objects.InspectObject(ctx, allocation.Object.ObjectKey)
	if err != nil {
		if errors.Is(err, objectstorage.ErrObjectNotFound) {
			return CommittedObject{}, ErrObjectFactsMismatch
		}
		return CommittedObject{}, fmt.Errorf("inspect render object: %w", err)
	}
	checksum, err := objectstorage.ObjectSHA256(facts)
	if err != nil || facts.Size != allocation.ExpectedByteSize || facts.ContentType != allocation.ExpectedContentType || strings.TrimSpace(facts.ETag) == "" || !equalBytes(checksum, allocation.ExpectedSHA256) {
		return CommittedObject{}, ErrObjectFactsMismatch
	}
	return s.repository.CommitObject(ctx, allocation, facts, s.now().UTC())
}

func (s Service) CommitRender(ctx context.Context, input CommitInput) (CommitResult, error) {
	if err := input.Validate(); err != nil {
		return CommitResult{}, err
	}
	result, err := s.repository.Commit(ctx, input, s.now().UTC())
	if err != nil {
		return CommitResult{}, err
	}
	if s.wake != nil && result.Transcription != nil {
		for _, jobID := range result.Transcription.JobIDs {
			s.wake(ctx, jobID)
		}
	}
	return result, nil
}

// CommitTranscriptionPreparation completes only the independently leased
// microphone preparation job. It intentionally has no presentation artifact
// side effect, so MP4 export and transcription can finish in either order.
func (s Service) CommitTranscriptionPreparation(ctx context.Context, input TranscriptionPreparationInput) (*TranscriptionResult, error) {
	if err := input.Validate(); err != nil {
		return nil, err
	}
	result, err := s.repository.CommitTranscriptionPreparation(ctx, input, s.now().UTC())
	if err != nil {
		return nil, err
	}
	if s.wake != nil && result != nil {
		for _, jobID := range result.JobIDs {
			s.wake(ctx, jobID)
		}
	}
	return result, nil
}

func (s Service) downloadable(ctx context.Context, facts ObjectFacts, expiresAt time.Time) (DownloadableObject, error) {
	download, err := s.download(ctx, facts, expiresAt, "")
	if err != nil {
		return DownloadableObject{}, err
	}
	return DownloadableObject{ObjectFacts: cloneObjectFacts(facts), Download: download}, nil
}

func (s Service) download(ctx context.Context, facts ObjectFacts, expiresAt time.Time, disposition string) (DownloadGrant, error) {
	now := s.now().UTC()
	signed, err := s.objects.CreateDownloadURL(ctx, objectstorage.CreateDownloadURLInput{Key: facts.ObjectKey, VersionID: facts.ObjectVersion, IfMatch: facts.ObjectETag, ContentDisposition: disposition, ExpiresIn: expiresAt.Sub(now)})
	if err != nil {
		return DownloadGrant{}, err
	}
	return DownloadGrant{Method: signed.Method, URL: signed.URL, ExpiresAt: signed.ExpiresAt, SignedHeaders: cloneHeaders(signed.SignedHeader)}, nil
}

func validateStoredInput(stored StoredInput) error {
	if stored.TranscriptionMode.Validate() != nil {
		return ErrInputIncomplete
	}
	if len(stored.Capture) == 0 {
		return ErrInputIncomplete
	}
	if len(stored.Capture) > MaximumCaptureObjects || len(stored.Presentation.Assets) > MaximumAssetObjects {
		return ErrInputTooLarge
	}
	presentation := stored.Presentation
	if presentation.Handle.IsZero() || presentation.SchemaVersion != PresentationSchemaVersion || strings.TrimSpace(presentation.ProfileVersion) == "" || presentation.DurationMillis <= 0 || presentation.DurationMillis > recordingpipeline.MaximumRecordingDuration.Milliseconds() || presentation.CaptureReadyAt.IsZero() || len(presentation.SHA256) != sha256.Size {
		return ErrInputIncomplete
	}
	if err := validateObjectFacts(presentation.Object); err != nil || !equalBytes(presentation.Object.SHA256, presentation.SHA256) {
		return ErrInputIncomplete
	}
	if err := validateObjectFacts(presentation.AssetManifest); err != nil || presentation.AssetManifest.ByteSize > MaximumManifestBytes {
		return ErrInputIncomplete
	}
	if presentation.Object.ByteSize > MaximumRenderInputBytes-presentation.AssetManifest.ByteSize {
		return ErrInputTooLarge
	}
	totalBytes := presentation.Object.ByteSize + presentation.AssetManifest.ByteSize
	type captureKeyAuthority struct {
		jobID          utilities.ID
		keyHandle      utilities.ID
		envelopeDigest string
	}
	epochAuthorities := make(map[int64]captureKeyAuthority)
	for index, captureObject := range stored.Capture {
		if captureObject.CaptureEpoch <= 0 || captureObject.CaptureEpoch > stored.Authority.CaptureEpoch || captureObject.CaptureJobID.IsZero() || captureObject.KeyHandle.IsZero() || len(captureObject.EnvelopeDigest) != sha256.Size ||
			captureObject.SequenceNumber < 0 || (index > 0 && captureObject.SequenceNumber <= stored.Capture[index-1].SequenceNumber) || (index > 0 && captureObject.CaptureEpoch < stored.Capture[index-1].CaptureEpoch) ||
			captureObject.MonotonicStartMillis < 0 || captureObject.MonotonicEndMillis < captureObject.MonotonicStartMillis || captureObject.MediaStartMillis < 0 || captureObject.MediaEndMillis < captureObject.MediaStartMillis || strings.TrimSpace(captureObject.Codec) == "" {
			return ErrInputIncomplete
		}
		epochAuthority := captureKeyAuthority{jobID: captureObject.CaptureJobID, keyHandle: captureObject.KeyHandle, envelopeDigest: string(captureObject.EnvelopeDigest)}
		if existing, ok := epochAuthorities[captureObject.CaptureEpoch]; ok && existing != epochAuthority {
			return ErrInputIncomplete
		}
		epochAuthorities[captureObject.CaptureEpoch] = epochAuthority
		if captureObject.CaptureEpoch == stored.Authority.CaptureEpoch && captureObject.KeyHandle != stored.Authority.KeyHandle {
			return ErrAuthorityMismatch
		}
		if err := validateObjectFacts(captureObject.ObjectFacts); err != nil {
			return ErrInputIncomplete
		}
		if totalBytes > MaximumRenderInputBytes-captureObject.ByteSize {
			return ErrInputTooLarge
		}
		totalBytes += captureObject.ByteSize
	}
	for _, asset := range presentation.Assets {
		if err := validateObjectFacts(asset); err != nil {
			return ErrInputIncomplete
		}
		if totalBytes > MaximumRenderInputBytes-asset.ByteSize {
			return ErrInputTooLarge
		}
		totalBytes += asset.ByteSize
	}
	return nil
}

func renderObjectKey(authority Authority, purpose ObjectPurpose, allocationID utilities.ID) string {
	extension := "json"
	switch purpose {
	case PurposeRecordingVideo:
		extension = "mp4"
	case PurposeTranscriptionAudio:
		extension = "flac"
	}
	return fmt.Sprintf("tenants/%s/recordings/%s/render/%d/%s/%s.%s", authority.TenantID.String(), authority.RecordingID.String(), authority.CaptureEpoch, purpose, allocationID.String(), extension)
}

func opaqueToken() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func tokenHash(value string) []byte {
	digest := sha256.Sum256([]byte(value))
	return append([]byte(nil), digest[:]...)
}

func sameFinalization(allocation Allocation, input FinalizeObjectInput) bool {
	return allocation.ExpectedContentType == input.ContentType && allocation.ExpectedByteSize == input.ByteSize && equalBytes(allocation.ExpectedSHA256, input.SHA256) && equalOptionalInt64(allocation.ExpectedDurationMillis, input.DurationMillis)
}

func cloneObjectFacts(value ObjectFacts) ObjectFacts {
	value.SHA256 = append([]byte(nil), value.SHA256...)
	return value
}

func cloneCaptureObject(value CaptureObject) CaptureObject {
	value.ObjectFacts = cloneObjectFacts(value.ObjectFacts)
	value.EnvelopeDigest = append([]byte(nil), value.EnvelopeDigest...)
	if value.Layer != nil {
		layer := *value.Layer
		value.Layer = &layer
	}
	return value
}

func cloneInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
}

func equalOptionalInt64(left, right *int64) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

func equalBytes(left, right []byte) bool {
	return bytes.Equal(left, right)
}

func cloneHeaders(value map[string][]string) map[string][]string {
	result := make(map[string][]string, len(value))
	for name, values := range value {
		result[name] = append([]string(nil), values...)
	}
	return result
}
