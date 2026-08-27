package captureplane

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"hash"
	"sort"
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

func (d Description) Validate() error {
	if len(d.SDP) == 0 || len(d.SDP) > MaxSDPBytes || !strings.HasPrefix(d.SDP, "v=") {
		return fmt.Errorf("%w: SDP body", ErrInvalidDescription)
	}
	switch d.Type {
	case "offer", "answer", "pranswer", "rollback":
		return nil
	default:
		return fmt.Errorf("%w: SDP type %q", ErrInvalidDescription, d.Type)
	}
}

func (n Negotiation) Validate() error {
	switch n.Requirement {
	case NegotiationNotRequired:
		if !n.ID.IsZero() || n.Description != nil {
			return fmt.Errorf("%w: unexpected negotiation payload", ErrInvalidNegotiation)
		}
	case NegotiationAnswerNeeded:
		if err := validateProviderReference(n.ID); err != nil {
			return fmt.Errorf("%w: negotiation id: %w", ErrInvalidNegotiation, err)
		}
		if n.Description == nil {
			return fmt.Errorf("%w: missing negotiation description", ErrInvalidNegotiation)
		}
		if err := n.Description.Validate(); err != nil {
			return fmt.Errorf("%w: %w", ErrInvalidNegotiation, err)
		}
		if n.Description.Type != "offer" {
			return fmt.Errorf("%w: answer-needed description must be an offer", ErrInvalidNegotiation)
		}
	case NegotiationOfferNeeded:
		if err := validateProviderReference(n.ID); err != nil {
			return fmt.Errorf("%w: negotiation id: %w", ErrInvalidNegotiation, err)
		}
		if n.Description != nil {
			if err := n.Description.Validate(); err != nil {
				return fmt.Errorf("%w: %w", ErrInvalidNegotiation, err)
			}
			if n.Description.Type != "offer" {
				return fmt.Errorf("%w: offer-needed description must be an offer", ErrInvalidNegotiation)
			}
		}
	case NegotiationRemoteAnswer:
		if !n.ID.IsZero() {
			return fmt.Errorf("%w: remote answer cannot fence a renegotiation", ErrInvalidNegotiation)
		}
		if n.Description == nil {
			return fmt.Errorf("%w: missing remote answer description", ErrInvalidNegotiation)
		}
		if err := n.Description.Validate(); err != nil {
			return fmt.Errorf("%w: %w", ErrInvalidNegotiation, err)
		}
		if n.Description.Type != "answer" {
			return fmt.Errorf("%w: remote answer description must be an answer", ErrInvalidNegotiation)
		}
	default:
		return fmt.Errorf("%w: requirement %q", ErrInvalidNegotiation, n.Requirement)
	}
	return nil
}

func (r CaptureConnection) Validate() error {
	if err := validateProviderReference(r.ConnectionReference); err != nil {
		return fmt.Errorf("%w: connection reference: %w", ErrInvalidConnection, err)
	}
	if r.CaptureEpoch == 0 || r.PlanRevision == 0 {
		return fmt.Errorf("%w: connection fence", ErrInvalidConnection)
	}
	return nil
}

// ValidateAgainst checks that a provider result still belongs to the command
// fence that authorized it. A mismatch must be discarded by the worker.
func (r CaptureConnection) ValidateAgainst(metadata OperationMetadata, operation OperationKind) error {
	if err := metadata.validate(operation); err != nil {
		return err
	}
	if err := r.Validate(); err != nil {
		return err
	}
	if r.CaptureEpoch != metadata.CaptureEpoch {
		return NewFencedError(operation, FencedByCaptureEpoch, metadata.CaptureEpoch, r.CaptureEpoch, metadata.PlanRevision, r.PlanRevision)
	}
	if r.PlanRevision != metadata.PlanRevision {
		return NewFencedError(operation, FencedByPlanRevision, metadata.CaptureEpoch, r.CaptureEpoch, metadata.PlanRevision, r.PlanRevision)
	}
	return nil
}

func (r CreateCaptureConnectionResult) Validate() error {
	if err := r.Connection.Validate(); err != nil {
		return err
	}
	return r.Negotiation.Validate()
}

func (r CreateCaptureConnectionResult) ValidateAgainst(metadata OperationMetadata) error {
	if err := r.Connection.ValidateAgainst(metadata, OperationCreateCaptureConnection); err != nil {
		return err
	}
	return r.Negotiation.Validate()
}

func (r PullCaptureTracksResult) Validate() error {
	if err := r.Connection.Validate(); err != nil {
		return err
	}
	if len(r.Tracks) > MaxCaptureTracks {
		return fmt.Errorf("%w: too many pulled tracks", ErrInvalidTrack)
	}
	if err := validatePulledTracks(r.Tracks); err != nil {
		return err
	}
	return r.Negotiation.Validate()
}

func (r PullCaptureTracksResult) ValidateAgainst(metadata OperationMetadata) error {
	if err := r.Connection.ValidateAgainst(metadata, OperationPullCaptureTracks); err != nil {
		return err
	}
	if err := r.Validate(); err != nil {
		return err
	}
	return nil
}

func (r RenegotiateCaptureConnectionResult) Validate() error {
	if err := r.Connection.Validate(); err != nil {
		return err
	}
	return r.Negotiation.Validate()
}

func (r RenegotiateCaptureConnectionResult) ValidateAgainst(metadata OperationMetadata) error {
	if err := r.Connection.ValidateAgainst(metadata, OperationRenegotiateCaptureConnection); err != nil {
		return err
	}
	if err := r.Validate(); err != nil {
		return err
	}
	return nil
}

func (r InspectCaptureConnectionResult) Validate() error {
	if err := r.Connection.Validate(); err != nil {
		return err
	}
	switch r.State {
	case CaptureConnectionConnecting, CaptureConnectionConnected, CaptureConnectionDisconnected, CaptureConnectionClosed:
	default:
		return fmt.Errorf("%w: unknown connection state %q", ErrInvalidConnection, r.State)
	}
	if len(r.Tracks) > MaxCaptureTracks {
		return fmt.Errorf("%w: too many observed tracks", ErrInvalidTrack)
	}
	if err := validateObservedTracks(r.Tracks); err != nil {
		return err
	}
	return r.Negotiation.Validate()
}

func (r InspectCaptureConnectionResult) ValidateAgainst(metadata OperationMetadata) error {
	if err := r.Connection.ValidateAgainst(metadata, OperationInspectCaptureConnection); err != nil {
		return err
	}
	if err := r.Validate(); err != nil {
		return err
	}
	return nil
}

func (r CloseCaptureTracksResult) Validate() error {
	if err := r.Connection.Validate(); err != nil {
		return err
	}
	if len(r.Tracks) > MaxCaptureTracks {
		return fmt.Errorf("%w: too many closed tracks", ErrInvalidTrack)
	}
	if err := validatePulledTracks(r.Tracks); err != nil {
		return err
	}
	return r.Negotiation.Validate()
}

func (r CloseCaptureTracksResult) ValidateAgainst(metadata OperationMetadata) error {
	if err := r.Connection.ValidateAgainst(metadata, OperationCloseCaptureTracks); err != nil {
		return err
	}
	if err := r.Validate(); err != nil {
		return err
	}
	return nil
}

func (r CloseCaptureConnectionResult) Validate() error {
	if err := r.Connection.Validate(); err != nil {
		return err
	}
	return nil
}

func (r CloseCaptureConnectionResult) ValidateAgainst(metadata OperationMetadata) error {
	if err := r.Connection.ValidateAgainst(metadata, OperationCloseCaptureConnection); err != nil {
		return err
	}
	if err := r.Validate(); err != nil {
		return err
	}
	return nil
}

func (t CaptureTrack) Validate() error {
	if err := validateProviderReference(t.OwnerReference); err != nil {
		return fmt.Errorf("%w: owner reference: %w", ErrInvalidTrack, err)
	}
	if err := validateProviderReference(t.TrackReference); err != nil {
		return fmt.Errorf("%w: track reference: %w", ErrInvalidTrack, err)
	}
	if t.ParticipantID.IsZero() || t.ParticipantGeneration <= 0 {
		return fmt.Errorf("%w: participant identity", ErrInvalidTrack)
	}
	if !validTrackSource(t.Source) || !validTrackKind(t.Kind) || !validTrackLayer(t.RequestedLayer) {
		return fmt.Errorf("%w: source, kind, or layer", ErrInvalidTrack)
	}
	if (t.Source == TrackSourceMicrophone) != (t.Kind == TrackKindAudio) {
		return fmt.Errorf("%w: source and kind do not agree", ErrInvalidTrack)
	}
	if t.Kind == TrackKindAudio && t.RequestedLayer != TrackLayerAuto {
		return fmt.Errorf("%w: audio tracks must use auto layer", ErrInvalidTrack)
	}
	return nil
}

func (t PulledCaptureTrack) Validate() error {
	if err := t.CaptureTrack.Validate(); err != nil {
		return err
	}
	if err := validateProviderReference(t.MID); err != nil {
		return fmt.Errorf("%w: MID: %w", ErrInvalidTrack, err)
	}
	return nil
}

func (t ObservedCaptureTrack) Validate() error {
	return t.PulledCaptureTrack.Validate()
}

func CanonicalizeCaptureTracks(tracks []CaptureTrack) ([]CaptureTrack, error) {
	if err := validateTracks(tracks); err != nil {
		return nil, err
	}
	canonical := append([]CaptureTrack(nil), tracks...)
	for index := range canonical {
		canonical[index].OwnerReference = ProviderReference(strings.TrimSpace(string(canonical[index].OwnerReference)))
		canonical[index].TrackReference = ProviderReference(strings.TrimSpace(string(canonical[index].TrackReference)))
		canonical[index].Source = TrackSource(strings.TrimSpace(string(canonical[index].Source)))
		canonical[index].Kind = TrackKind(strings.TrimSpace(string(canonical[index].Kind)))
		canonical[index].RequestedLayer = TrackLayer(strings.TrimSpace(string(canonical[index].RequestedLayer)))
	}
	sort.Slice(canonical, func(left, right int) bool {
		first, second := canonical[left], canonical[right]
		if first.ParticipantID.String() != second.ParticipantID.String() {
			return first.ParticipantID.String() < second.ParticipantID.String()
		}
		if first.ParticipantGeneration != second.ParticipantGeneration {
			return first.ParticipantGeneration < second.ParticipantGeneration
		}
		if first.Source != second.Source {
			return first.Source < second.Source
		}
		if first.Kind != second.Kind {
			return first.Kind < second.Kind
		}
		if first.OwnerReference != second.OwnerReference {
			return first.OwnerReference < second.OwnerReference
		}
		if first.TrackReference != second.TrackReference {
			return first.TrackReference < second.TrackReference
		}
		return first.RequestedLayer < second.RequestedLayer
	})
	return canonical, nil
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

// CanonicalizePulledCaptureTracks preserves the provider MID while giving
// retry fingerprints a stable order. Empty input is valid for optional
// inspection and connection-close track lists.
func CanonicalizePulledCaptureTracks(tracks []PulledCaptureTrack) ([]PulledCaptureTrack, error) {
	if len(tracks) > MaxCaptureTracks {
		return nil, fmt.Errorf("%w: too many pulled tracks", ErrInvalidTrack)
	}
	if err := validatePulledTracks(tracks); err != nil && len(tracks) > 0 {
		return nil, err
	}
	canonical := append([]PulledCaptureTrack(nil), tracks...)
	for index := range canonical {
		canonical[index].OwnerReference = ProviderReference(strings.TrimSpace(string(canonical[index].OwnerReference)))
		canonical[index].TrackReference = ProviderReference(strings.TrimSpace(string(canonical[index].TrackReference)))
		canonical[index].MID = ProviderReference(strings.TrimSpace(string(canonical[index].MID)))
		canonical[index].Source = TrackSource(strings.TrimSpace(string(canonical[index].Source)))
		canonical[index].Kind = TrackKind(strings.TrimSpace(string(canonical[index].Kind)))
		canonical[index].RequestedLayer = TrackLayer(strings.TrimSpace(string(canonical[index].RequestedLayer)))
	}
	sort.Slice(canonical, func(left, right int) bool {
		first, second := canonical[left], canonical[right]
		if first.ParticipantID.String() != second.ParticipantID.String() {
			return first.ParticipantID.String() < second.ParticipantID.String()
		}
		if first.ParticipantGeneration != second.ParticipantGeneration {
			return first.ParticipantGeneration < second.ParticipantGeneration
		}
		if first.Source != second.Source {
			return first.Source < second.Source
		}
		if first.Kind != second.Kind {
			return first.Kind < second.Kind
		}
		if first.OwnerReference != second.OwnerReference {
			return first.OwnerReference < second.OwnerReference
		}
		if first.TrackReference != second.TrackReference {
			return first.TrackReference < second.TrackReference
		}
		if first.RequestedLayer != second.RequestedLayer {
			return first.RequestedLayer < second.RequestedLayer
		}
		return first.MID < second.MID
	})
	return canonical, nil
}

func validateTracks(tracks []CaptureTrack) error {
	if len(tracks) == 0 || len(tracks) > MaxCaptureTracks {
		return fmt.Errorf("%w: track count must be between one and %d", ErrInvalidTrack, MaxCaptureTracks)
	}
	seenIdentity := make(map[string]struct{}, len(tracks))
	seenProvider := make(map[string]struct{}, len(tracks))
	for _, track := range tracks {
		if err := track.Validate(); err != nil {
			return err
		}
		identity := fmt.Sprintf("%s:%d:%s:%s", track.ParticipantID, track.ParticipantGeneration, track.Source, track.Kind)
		if _, exists := seenIdentity[identity]; exists {
			return fmt.Errorf("%w: participant publication %s", ErrDuplicateTrack, identity)
		}
		seenIdentity[identity] = struct{}{}
		provider := string(track.OwnerReference) + "\x00" + string(track.TrackReference)
		if _, exists := seenProvider[provider]; exists {
			return fmt.Errorf("%w: provider publication", ErrDuplicateTrack)
		}
		seenProvider[provider] = struct{}{}
	}
	return nil
}

func validatePulledTracks(tracks []PulledCaptureTrack) error {
	seenIdentity := make(map[string]struct{}, len(tracks))
	seenProvider := make(map[string]struct{}, len(tracks))
	seenMID := make(map[ProviderReference]struct{}, len(tracks))
	for _, track := range tracks {
		if err := track.Validate(); err != nil {
			return err
		}
		identity := fmt.Sprintf("%s:%d:%s:%s", track.ParticipantID, track.ParticipantGeneration, track.Source, track.Kind)
		if _, exists := seenIdentity[identity]; exists {
			return fmt.Errorf("%w: participant publication %s", ErrDuplicateTrack, identity)
		}
		seenIdentity[identity] = struct{}{}
		provider := string(track.OwnerReference) + "\x00" + string(track.TrackReference)
		if _, exists := seenProvider[provider]; exists {
			return fmt.Errorf("%w: provider publication", ErrDuplicateTrack)
		}
		seenProvider[provider] = struct{}{}
		if _, exists := seenMID[track.MID]; exists {
			return fmt.Errorf("%w: provider MID", ErrDuplicateTrack)
		}
		seenMID[track.MID] = struct{}{}
	}
	return nil
}

func validateObservedTracks(tracks []ObservedCaptureTrack) error {
	pulled := make([]PulledCaptureTrack, 0, len(tracks))
	for _, track := range tracks {
		pulled = append(pulled, track.PulledCaptureTrack)
	}
	return validatePulledTracks(pulled)
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

func validOperationKind(kind OperationKind) bool {
	switch kind {
	case OperationCreateCaptureConnection, OperationPullCaptureTracks, OperationRenegotiateCaptureConnection, OperationInspectCaptureConnection, OperationCloseCaptureTracks, OperationCloseCaptureConnection:
		return true
	default:
		return false
	}
}

func validTrackSource(source TrackSource) bool {
	switch source {
	case TrackSourceMicrophone, TrackSourceCamera, TrackSourceScreen:
		return true
	default:
		return false
	}
}

func validTrackKind(kind TrackKind) bool {
	return kind == TrackKindAudio || kind == TrackKindVideo
}

func validTrackLayer(layer TrackLayer) bool {
	switch layer {
	case TrackLayerAuto, TrackLayerHigh, TrackLayerMedium, TrackLayerLow:
		return true
	default:
		return false
	}
}
