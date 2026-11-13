package recordingrender

import (
	"context"
	"crypto/sha256"
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
