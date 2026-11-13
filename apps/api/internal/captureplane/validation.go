package captureplane

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"hash"
	"strings"
)

func (i CaptureIdentity) Validate() error {
	if i.TenantID.IsZero() || i.SpaceID.IsZero() || i.EpisodeID.IsZero() || i.RecordingID.IsZero() {
		return fmt.Errorf("%w: %w", ErrInvalidInput, ErrInvalidIdentity)
	}
	return nil
}

func (m OperationMetadata) validate(kind OperationKind) error {
	if err := m.Validate(); err != nil {
		return err
	}
	if !validOperationKind(kind) {
		return fmt.Errorf("%w: unknown operation kind %q", ErrInvalidInput, kind)
	}
	return nil
}

func (m OperationMetadata) Validate() error {
	if err := m.Identity.Validate(); err != nil {
		return err
	}
	if m.CaptureEpoch == 0 {
		return fmt.Errorf("%w: %w", ErrInvalidInput, ErrInvalidCaptureEpoch)
	}
	if m.PlanRevision == 0 {
		return fmt.Errorf("%w: %w", ErrInvalidInput, ErrInvalidPlanRevision)
	}
	key := strings.TrimSpace(m.IdempotencyKey)
	if key == "" || key != m.IdempotencyKey || len(key) > MaxIdempotencyKeyBytes {
		return fmt.Errorf("%w: %w", ErrInvalidInput, ErrInvalidIdempotencyKey)
	}
	return nil
}

// IdempotencyScope returns the stable command namespace shared by retries of
// one operation. Adapters should combine it with a canonical operation
// payload before storing a result, so reusing a key for different input is a
// conflict rather than a replay.
func (m OperationMetadata) IdempotencyScope(kind OperationKind) ([32]byte, error) {
	if err := m.validate(kind); err != nil {
		return [32]byte{}, err
	}
	hasher := sha256.New()
	writeScopeField(hasher, []byte(kind))
	identity := m.Identity
	tenant := identity.TenantID.Bytes()
	space := identity.SpaceID.Bytes()
	episode := identity.EpisodeID.Bytes()
	recording := identity.RecordingID.Bytes()
	writeScopeField(hasher, tenant[:])
	writeScopeField(hasher, space[:])
	writeScopeField(hasher, episode[:])
	writeScopeField(hasher, recording[:])
	var number [8]byte
	binary.BigEndian.PutUint64(number[:], uint64(m.CaptureEpoch))
	writeScopeField(hasher, number[:])
	binary.BigEndian.PutUint64(number[:], uint64(m.PlanRevision))
	writeScopeField(hasher, number[:])
	writeScopeField(hasher, []byte(m.IdempotencyKey))
	var scope [32]byte
	copy(scope[:], hasher.Sum(nil))
	return scope, nil
}

func (i CreateCaptureConnectionInput) Validate() error {
	return i.Metadata.validate(OperationCreateCaptureConnection)
}

func (i PullCaptureTracksInput) Validate() error {
	if err := i.Metadata.validate(OperationPullCaptureTracks); err != nil {
		return err
	}
	if err := validateProviderReference(i.Connection); err != nil {
		return fmt.Errorf("%w: connection: %w", ErrInvalidInput, err)
	}
	if err := validateTracks(i.Tracks); err != nil {
		return err
	}
	if i.LocalDescription != nil {
		if err := i.LocalDescription.Validate(); err != nil {
			return err
		}
	}
	return nil
}

func (i RenegotiateCaptureConnectionInput) Validate() error {
	if err := i.Metadata.validate(OperationRenegotiateCaptureConnection); err != nil {
		return err
	}
	if err := validateProviderReference(i.Connection); err != nil {
		return fmt.Errorf("%w: connection: %w", ErrInvalidInput, err)
	}
	if err := validateProviderReference(i.NegotiationID); err != nil {
		return fmt.Errorf("%w: negotiation: %w", ErrInvalidInput, err)
	}
	return i.Description.Validate()
}

func (i InspectCaptureConnectionInput) Validate() error {
	if err := i.Metadata.validate(OperationInspectCaptureConnection); err != nil {
		return err
	}
	if err := validateProviderReference(i.Connection); err != nil {
		return fmt.Errorf("%w: connection: %w", ErrInvalidInput, err)
	}
	if len(i.Tracks) > MaxCaptureTracks {
		return fmt.Errorf("%w: too many inspected tracks", ErrInvalidTrack)
	}
	if err := validatePulledTracks(i.Tracks); err != nil && len(i.Tracks) > 0 {
		return err
	}
	return nil
}

func (i CloseCaptureTracksInput) Validate() error {
	if err := i.Metadata.validate(OperationCloseCaptureTracks); err != nil {
		return err
	}
	if err := validateProviderReference(i.Connection); err != nil {
		return fmt.Errorf("%w: connection: %w", ErrInvalidInput, err)
	}
	if len(i.Tracks) == 0 || len(i.Tracks) > MaxCaptureTracks {
		return fmt.Errorf("%w: track count must be between one and %d", ErrInvalidTrack, MaxCaptureTracks)
	}
	if err := validatePulledTracks(i.Tracks); err != nil {
		return err
	}
	return nil
}

func (i CloseCaptureConnectionInput) Validate() error {
	if err := i.Metadata.validate(OperationCloseCaptureConnection); err != nil {
		return err
	}
	if err := validateProviderReference(i.Connection); err != nil {
		return fmt.Errorf("%w: connection: %w", ErrInvalidInput, err)
	}
	if len(i.Tracks) > MaxCaptureTracks {
		return fmt.Errorf("%w: too many connection tracks", ErrInvalidTrack)
	}
	if err := validatePulledTracks(i.Tracks); err != nil && len(i.Tracks) > 0 {
		return err
	}
	return nil
}

func CanonicalizePullCaptureTracksInput(input PullCaptureTracksInput) (PullCaptureTracksInput, error) {
	if err := input.Validate(); err != nil {
		return PullCaptureTracksInput{}, err
	}
	canonical, err := CanonicalizeCaptureTracks(input.Tracks)
	if err != nil {
		return PullCaptureTracksInput{}, err
	}
	input.Tracks = canonical
	return input, nil
}

func CanonicalizeCloseCaptureTracksInput(input CloseCaptureTracksInput) (CloseCaptureTracksInput, error) {
	if err := input.Validate(); err != nil {
		return CloseCaptureTracksInput{}, err
	}
	canonical, err := CanonicalizePulledCaptureTracks(input.Tracks)
	if err != nil {
		return CloseCaptureTracksInput{}, err
	}
	input.Tracks = canonical
	return input, nil
}

func CanonicalizeInspectCaptureConnectionInput(input InspectCaptureConnectionInput) (InspectCaptureConnectionInput, error) {
	if err := input.Validate(); err != nil {
		return InspectCaptureConnectionInput{}, err
	}
	canonical, err := CanonicalizePulledCaptureTracks(input.Tracks)
	if err != nil {
		return InspectCaptureConnectionInput{}, err
	}
	input.Tracks = canonical
	return input, nil
}

func CanonicalizeCloseCaptureConnectionInput(input CloseCaptureConnectionInput) (CloseCaptureConnectionInput, error) {
	if err := input.Validate(); err != nil {
		return CloseCaptureConnectionInput{}, err
	}
	canonical, err := CanonicalizePulledCaptureTracks(input.Tracks)
	if err != nil {
		return CloseCaptureConnectionInput{}, err
	}
	input.Tracks = canonical
	return input, nil
}

func writeScopeField(hasher hash.Hash, value []byte) {
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(value)))
	_, _ = hasher.Write(length[:])
	_, _ = hasher.Write(value)
}

func validateProviderReference(reference ProviderReference) error {
	value := string(reference)
	if value == "" || len(value) > MaxProviderReference || strings.TrimSpace(value) != value {
		return ErrInvalidProviderRef
	}
	return nil
}
