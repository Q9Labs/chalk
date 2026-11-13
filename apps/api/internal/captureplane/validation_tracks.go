package captureplane

import (
	"fmt"
	"sort"
	"strings"
)

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
