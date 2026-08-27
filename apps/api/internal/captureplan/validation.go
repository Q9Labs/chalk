package captureplan

import (
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func validatePlanInput(input PlanInput) error {
	if err := validateAuthority(input.Authority); err != nil {
		return err
	}
	if input.Revision == 0 || uint64(input.Revision) > math.MaxInt64 {
		return fmt.Errorf("%w: revision must be positive", ErrInvalidPlan)
	}
	if input.Cursors.EpisodeControlRevision < 0 || input.Cursors.ProviderIncarnation < 0 || input.Cursors.ProviderSequence < 0 ||
		(input.Cursors.ProviderIncarnation == 0 && input.Cursors.ProviderSequence != 0) {
		return fmt.Errorf("%w: source cursors are invalid", ErrInvalidPlan)
	}
	if input.LayoutProfile != LayoutProfileComposite720PV1 {
		return fmt.Errorf("%w: unsupported layout profile %q", ErrInvalidPlan, input.LayoutProfile)
	}
	if input.ParticipantLimit <= 0 || input.ParticipantLimit > MaximumParticipants {
		return fmt.Errorf("%w: participant limit must be between one and %d", ErrInvalidPlan, MaximumParticipants)
	}
	if input.InputBitrateBPS <= 0 || input.InputBitrateBPS > MaximumInputBitrateBPS {
		return fmt.Errorf("%w: input bitrate must be between one and %d", ErrInvalidPlan, MaximumInputBitrateBPS)
	}
	if input.EffectiveDeadline.IsZero() {
		return fmt.Errorf("%w: effective deadline is required", ErrInvalidPlan)
	}
	if err := validateStop(input.StopState, input.StopRequestedAt); err != nil {
		return err
	}
	if len(input.Participants) > input.ParticipantLimit || len(input.Participants) > MaximumParticipants {
		return fmt.Errorf("%w: participant count exceeds limit", ErrInvalidPlan)
	}
	if len(input.Tracks) > MaximumTracks {
		return fmt.Errorf("%w: track count exceeds limit %d", ErrInvalidPlan, MaximumTracks)
	}

	participants := make(map[string]ParticipantSnapshot, len(input.Participants))
	joinOrdinals := make(map[int64]struct{}, len(input.Participants))
	for _, participant := range input.Participants {
		if err := validateParticipant(participant); err != nil {
			return err
		}
		id := participant.ID.String()
		if _, exists := participants[id]; exists {
			return fmt.Errorf("%w: duplicate participant %s", ErrInvalidParticipant, id)
		}
		if _, exists := joinOrdinals[participant.JoinOrdinal]; exists {
			return fmt.Errorf("%w: duplicate join ordinal %d", ErrInvalidParticipant, participant.JoinOrdinal)
		}
		participants[id] = participant
		joinOrdinals[participant.JoinOrdinal] = struct{}{}
	}

	trackIdentities := make(map[string]struct{}, len(input.Tracks))
	providerReferences := make(map[string]struct{}, len(input.Tracks))
	ownerMIDs := make(map[string]struct{}, len(input.Tracks))
	publicationReferences := make(map[PublicationReference]struct{}, len(input.Tracks))
	for _, track := range input.Tracks {
		if err := validateTrack(track); err != nil {
			return err
		}
		participant, exists := participants[track.ParticipantID.String()]
		if !exists || participant.Generation != track.ParticipantGeneration {
			return fmt.Errorf("%w: participant generation does not match snapshot", ErrInvalidTrack)
		}
		identity := fmt.Sprintf("%s\x00%d\x00%s\x00%s", track.ParticipantID, track.ParticipantGeneration, track.Source, track.Kind)
		if _, exists := trackIdentities[identity]; exists {
			return fmt.Errorf("%w: duplicate participant source %s", ErrInvalidTrack, identity)
		}
		trackIdentities[identity] = struct{}{}
		provider := string(track.OwnerReference) + "\x00" + string(track.TrackReference)
		if _, exists := providerReferences[provider]; exists {
			return fmt.Errorf("%w: duplicate provider track", ErrInvalidTrack)
		}
		providerReferences[provider] = struct{}{}
		ownerMID := string(track.OwnerReference) + "\x00" + string(track.OwnerMID)
		if _, exists := ownerMIDs[ownerMID]; exists {
			return fmt.Errorf("%w: duplicate provider MID", ErrInvalidTrack)
		}
		ownerMIDs[ownerMID] = struct{}{}
		if _, exists := publicationReferences[track.PublicationReference]; exists {
			return fmt.Errorf("%w: duplicate publication reference", ErrInvalidTrack)
		}
		publicationReferences[track.PublicationReference] = struct{}{}
	}
	return nil
}

func validateAuthority(authority PlanAuthority) error {
	if !validOpaque(string(authority.PlanHandle), MaximumPlanHandle) {
		return fmt.Errorf("%w: plan handle", ErrInvalidAuthority)
	}
	if _, err := utilities.ParseID(string(authority.PlanHandle)); err != nil {
		return fmt.Errorf("%w: plan handle", ErrInvalidAuthority)
	}
	if authority.TenantID.IsZero() || authority.SpaceID.IsZero() || authority.EpisodeID.IsZero() || authority.RecordingID.IsZero() || authority.JobID.IsZero() {
		return fmt.Errorf("%w: all Chalk IDs are required", ErrInvalidAuthority)
	}
	if authority.AttemptCount <= 0 || authority.FencingGeneration <= 0 || authority.CaptureEpoch == 0 {
		return fmt.Errorf("%w: attempt, fencing generation, and capture epoch must be positive", ErrInvalidAuthority)
	}
	if !digestIsValid(authority.EnvelopeDigest) {
		return fmt.Errorf("%w: envelope digest must be a non-zero SHA-256 digest", ErrInvalidAuthority)
	}
	return nil
}

func validateParticipant(participant ParticipantSnapshot) error {
	if participant.ID.IsZero() {
		return fmt.Errorf("%w: participant ID is required", ErrInvalidParticipant)
	}
	if participant.Generation <= 0 || participant.JoinOrdinal == 0 {
		return fmt.Errorf("%w: generation and join ordinal must be positive", ErrInvalidParticipant)
	}
	if !validDisplayName(participant.DisplayName) {
		return fmt.Errorf("%w: display name must be between one and %d UTF-8 bytes", ErrInvalidParticipant, MaximumParticipantName)
	}
	switch participant.Lifecycle {
	case ParticipantActive, ParticipantLeft:
		return nil
	default:
		return fmt.Errorf("%w: unknown lifecycle %q", ErrInvalidParticipant, participant.Lifecycle)
	}
}

func validateTrack(track TrackSnapshot) error {
	if track.ParticipantID.IsZero() || track.ParticipantGeneration <= 0 {
		return fmt.Errorf("%w: participant identity", ErrInvalidTrack)
	}
	if !validCaptureSource(track.Source) || !validCaptureKind(track.Kind) {
		return fmt.Errorf("%w: source or kind", ErrInvalidTrack)
	}
	if (track.Source == captureplane.TrackSourceMicrophone) != (track.Kind == captureplane.TrackKindAudio) {
		return fmt.Errorf("%w: source and kind do not agree", ErrInvalidTrack)
	}
	if !validCaptureReference(track.OwnerReference) || !validCaptureReference(track.TrackReference) || !validCaptureReference(track.OwnerMID) {
		return fmt.Errorf("%w: provider reference", ErrInvalidTrack)
	}
	if !validOpaque(string(track.PublicationReference), MaximumPublicationRef) {
		return fmt.Errorf("%w: publication reference", ErrInvalidTrack)
	}
	if track.RequestedLayer != captureplane.TrackLayerAuto {
		return fmt.Errorf("%w: requested layer must be auto in %s", ErrInvalidTrack, SchemaVersion)
	}
	return nil
}

func validateStop(state StopState, requestedAt time.Time) error {
	switch state {
	case StopStateRunning:
		if !requestedAt.IsZero() {
			return fmt.Errorf("%w: running plan cannot have a stop request time", ErrInvalidPlan)
		}
	case StopStateRequested, StopStateStopped:
		if requestedAt.IsZero() {
			return fmt.Errorf("%w: stopped plan requires a stop request time", ErrInvalidPlan)
		}
	default:
		return fmt.Errorf("%w: unknown stop state %q", ErrInvalidPlan, state)
	}
	return nil
}

func validDisplayName(value string) bool {
	return value != "" && len(value) <= MaximumParticipantName && strings.TrimSpace(value) == value && utf8.ValidString(value)
}

func validCaptureReference(value captureplane.ProviderReference) bool {
	return validOpaque(string(value), captureplane.MaxProviderReference)
}

func validCaptureSource(source captureplane.TrackSource) bool {
	switch source {
	case captureplane.TrackSourceMicrophone, captureplane.TrackSourceCamera, captureplane.TrackSourceScreen:
		return true
	default:
		return false
	}
}

func validCaptureKind(kind captureplane.TrackKind) bool {
	return kind == captureplane.TrackKindAudio || kind == captureplane.TrackKindVideo
}
