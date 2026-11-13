package recordingpresentation

import (
	"fmt"
	"sort"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

func mediaAtOrigin(source CompletionSource) (*capturePlanFactView, map[string]activeTrack, int64, error) {
	active := make(map[string]activeTrack)
	var initial *capturePlanFactView
	previousRevision := int64(0)
	for _, fact := range source.CapturePlans {
		if fact.Revision != previousRevision+1 {
			return nil, nil, 0, fmt.Errorf("%w: capture plan gap", ErrInvalidCompletionSource)
		}
		if fact.CreatedAt.After(source.CaptureReadyAt) || fact.Revision > source.CapturePlanStartRevision {
			break
		}
		var err error
		active, err = tracksForPlan(source, fact, active)
		if err != nil {
			return nil, nil, 0, err
		}
		view := capturePlanFactView{Fact: fact, Participants: fact.Plan.Participants()}
		initial = &view
		previousRevision = fact.Revision
	}
	if source.CapturePlanStartRevision > 0 && (initial == nil || previousRevision != source.CapturePlanStartRevision) {
		return nil, nil, 0, fmt.Errorf("%w: missing capture-ready plan", ErrInvalidCompletionSource)
	}
	return initial, active, previousRevision, nil
}

type capturePlanFactView struct {
	Fact         CapturePlanFact
	Participants []captureplan.ParticipantSnapshot
}

func reconcileInitialParticipants(source CompletionSource, participants map[string]Participant, plan *capturePlanFactView, active map[string]activeTrack) error {
	if plan != nil {
		participantsAtPlan, err := controlParticipantsAtRevision(source, plan.Fact.Plan.Cursors().EpisodeControlRevision)
		if err != nil {
			return err
		}
		seen := make(map[string]struct{}, len(plan.Participants))
		for _, value := range plan.Participants {
			id := value.ID.String()
			participant, exists := participantsAtPlan[id]
			if !exists || !participant.Joined || value.Generation <= 0 || participant.DisplayName != value.DisplayName ||
				participant.JoinOrdinal != value.JoinOrdinal || value.Lifecycle != captureplan.ParticipantActive {
				return fmt.Errorf("%w: capture-ready participants diverge from control state", ErrInvalidCompletionSource)
			}
			seen[id] = struct{}{}
		}
		for id, participant := range participantsAtPlan {
			if participant.Joined {
				if _, exists := seen[id]; !exists {
					return fmt.Errorf("%w: capture-ready plan omitted participant", ErrInvalidCompletionSource)
				}
			}
		}
	}
	for id, participant := range participants {
		participant.MicrophoneMuted = true
		participant.CameraEnabled = false
		participant.ScreenShareEnabled = false
		participants[id] = participant
	}
	if err := hideDepartedMedia(participants, active); err != nil {
		return err
	}
	for _, track := range active {
		participant, exists := participants[track.source.ParticipantID]
		if !exists {
			return fmt.Errorf("%w: media references unknown participant", ErrInvalidCompletionSource)
		}
		if !participant.Joined {
			continue
		}
		switch track.source.Kind {
		case MediaKindMicrophone:
			participant.MicrophoneMuted = false
		case MediaKindCamera:
			participant.CameraEnabled = true
		case MediaKindScreenShare:
			participant.ScreenShareEnabled = true
		}
		participants[participant.ID] = participant
	}
	return nil
}

func hideDepartedMedia(participants map[string]Participant, active map[string]activeTrack) error {
	for key, track := range active {
		participant, exists := participants[track.source.ParticipantID]
		if !exists {
			return fmt.Errorf("%w: media references unknown participant", ErrInvalidCompletionSource)
		}
		if participant.Joined {
			continue
		}
		track.source.Visible = false
		active[key] = track
	}
	return nil
}

func tracksForPlan(source CompletionSource, fact CapturePlanFact, previous map[string]activeTrack) (map[string]activeTrack, error) {
	desired := make(map[string]activeTrack)
	captureEpoch := int64(fact.Plan.Authority().CaptureEpoch)
	composedEpoch, err := recordingbundle.ComposeTrackEpoch(uint64(captureEpoch), uint64(fact.Plan.Revision()))
	if err != nil {
		return nil, fmt.Errorf("%w: compose media track epoch", ErrInvalidCompletionSource)
	}
	for _, track := range fact.Plan.Tracks() {
		kind, err := presentationMediaKind(track.Source, track.Kind)
		if err != nil {
			return nil, err
		}
		key := track.ParticipantID.String() + "\x00" + string(kind)
		if _, exists := desired[key]; exists {
			return nil, fmt.Errorf("%w: duplicate active participant media kind", ErrInvalidCompletionSource)
		}
		binding := captureplane.CaptureTrack{
			OwnerReference: track.OwnerReference, TrackReference: track.TrackReference,
			ParticipantID: track.ParticipantID, ParticipantGeneration: track.ParticipantGeneration,
			Source: track.Source, Kind: track.Kind, RequestedLayer: track.RequestedLayer,
		}
		epoch := int64(composedEpoch)
		if prior, exists := previous[key]; exists &&
			prior.captureEpoch == captureEpoch &&
			prior.binding == binding {
			epoch = prior.source.Epoch
		}
		identity := MediaSourceIdentity{
			RecordingID: source.RecordingID.String(), ParticipantID: track.ParticipantID.String(),
			ParticipantGeneration: track.ParticipantGeneration, Kind: kind,
			TrackID: track.TrackReference.String(), Epoch: epoch,
		}
		sourceID, err := SourceID(identity)
		if err != nil {
			return nil, fmt.Errorf("%w: derive media source identity", ErrInvalidCompletionSource)
		}
		desired[key] = activeTrack{key: key, captureEpoch: captureEpoch, binding: binding, source: MediaSource{
			SourceID: sourceID, ParticipantID: identity.ParticipantID,
			ParticipantGeneration: identity.ParticipantGeneration, Kind: identity.Kind,
			TrackID: identity.TrackID, Epoch: identity.Epoch,
			Visible: identity.Kind != MediaKindMicrophone,
		}}
	}
	return desired, nil
}

func presentationMediaKind(source captureplane.TrackSource, kind captureplane.TrackKind) (MediaKind, error) {
	switch {
	case source == captureplane.TrackSourceMicrophone && kind == captureplane.TrackKindAudio:
		return MediaKindMicrophone, nil
	case source == captureplane.TrackSourceCamera && kind == captureplane.TrackKindVideo:
		return MediaKindCamera, nil
	case source == captureplane.TrackSourceScreen && kind == captureplane.TrackKindVideo:
		return MediaKindScreenShare, nil
	default:
		return "", fmt.Errorf("%w: invalid capture plan media source", ErrInvalidCompletionSource)
	}
}

func mediaCatalog(active map[string]activeTrack) []MediaSource {
	result := make([]MediaSource, 0, len(active))
	for _, track := range active {
		result = append(result, track.source)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].ParticipantID != result[j].ParticipantID {
			return result[i].ParticipantID < result[j].ParticipantID
		}
		if result[i].Kind != result[j].Kind {
			return result[i].Kind < result[j].Kind
		}
		if result[i].TrackID != result[j].TrackID {
			return result[i].TrackID < result[j].TrackID
		}
		return result[i].Epoch < result[j].Epoch
	})
	return result
}

type activeTrack struct {
	key          string
	captureEpoch int64
	binding      captureplane.CaptureTrack
	source       MediaSource
}

func unionTrackKeys(left, right map[string]activeTrack) []string {
	set := make(map[string]struct{}, len(left)+len(right))
	for key := range left {
		set[key] = struct{}{}
	}
	for key := range right {
		set[key] = struct{}{}
	}
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func appendParticipantMediaState(at int64, participantID string, kind MediaKind, enabled bool, appendEvent func(int64, int, Event)) {
	switch kind {
	case MediaKindMicrophone:
		appendEvent(at, 21, &ParticipantMicrophoneChangedEvent{Kind: "participant_microphone_changed", ParticipantID: participantID, Muted: !enabled})
	case MediaKindCamera:
		appendEvent(at, 21, &ParticipantCameraChangedEvent{Kind: "participant_camera_changed", ParticipantID: participantID, Enabled: enabled})
	case MediaKindScreenShare:
		appendEvent(at, 21, &ParticipantScreenShareChangedEvent{Kind: "participant_screen_share_changed", ParticipantID: participantID, Enabled: enabled})
	}
}
