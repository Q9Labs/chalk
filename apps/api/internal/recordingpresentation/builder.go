package recordingpresentation

import (
	"fmt"
	"sort"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

type builtPresentation struct {
	Timeline Timeline
	Assets   []assetMaterial
}

type scheduledEvent struct {
	at       int64
	priority int
	ordinal  int
	event    Event
}

func buildPresentation(source CompletionSource) (builtPresentation, error) {
	if err := validateCompletionSource(source); err != nil {
		return builtPresentation{}, err
	}

	controlParticipants, err := controlParticipantsAtOrigin(source)
	if err != nil {
		return builtPresentation{}, err
	}
	initialPlan, active, planEnd, err := mediaAtOrigin(source)
	if err != nil {
		return builtPresentation{}, err
	}
	if err := reconcileInitialParticipants(source, controlParticipants, initialPlan, active); err != nil {
		return builtPresentation{}, err
	}

	materials := make([]assetMaterial, 0)
	assetByID := make(map[string]int)
	initialChat, err := buildInitialChat(source, &materials, assetByID)
	if err != nil {
		return builtPresentation{}, err
	}
	if err := addWhiteboardFileAssets(source, &materials, assetByID); err != nil {
		return builtPresentation{}, err
	}

	whiteboard, err := whiteboardAtOrigin(source)
	if err != nil {
		return builtPresentation{}, err
	}
	shared := screenSharedContent(active)
	if whiteboard != nil && whiteboard.Presenting {
		assetID, addErr := addWhiteboardStateAsset(*whiteboard, source, &materials, assetByID)
		if addErr != nil {
			return builtPresentation{}, addErr
		}
		shared = SharedContent{Kind: "whiteboard", SceneID: whiteboard.SceneID, Revision: whiteboard.Revision, StateAssetID: assetID}
	}

	participants := make([]Participant, 0, len(controlParticipants))
	for _, participant := range controlParticipants {
		participants = append(participants, participant)
	}
	sort.Slice(participants, func(i, j int) bool {
		if participants[i].JoinOrdinal != participants[j].JoinOrdinal {
			return participants[i].JoinOrdinal < participants[j].JoinOrdinal
		}
		return participants[i].ID < participants[j].ID
	})
	media := mediaCatalog(active)

	scheduled := make([]scheduledEvent, 0)
	ordinal := 0
	appendScheduled := func(at int64, priority int, event Event) {
		ordinal++
		scheduled = append(scheduled, scheduledEvent{at: at, priority: priority, ordinal: ordinal, event: event})
	}

	controlEnd, err := scheduleControlTail(source, appendScheduled)
	if err != nil {
		return builtPresentation{}, err
	}
	active, planEnd, err = schedulePlanTail(source, active, planEnd, appendScheduled)
	if err != nil {
		return builtPresentation{}, err
	}
	chatEnd, err := scheduleChatTail(source, &materials, assetByID, appendScheduled)
	if err != nil {
		return builtPresentation{}, err
	}
	whiteboardEnd, err := scheduleWhiteboardTail(source, whiteboard, active, &materials, assetByID, appendScheduled)
	if err != nil {
		return builtPresentation{}, err
	}
	if err := scheduleReactions(source, appendScheduled); err != nil {
		return builtPresentation{}, err
	}

	sort.SliceStable(scheduled, func(i, j int) bool {
		if scheduled[i].at != scheduled[j].at {
			return scheduled[i].at < scheduled[j].at
		}
		if scheduled[i].priority != scheduled[j].priority {
			return scheduled[i].priority < scheduled[j].priority
		}
		return scheduled[i].ordinal < scheduled[j].ordinal
	})
	if len(scheduled) > MaximumEvents {
		return builtPresentation{}, fmt.Errorf("%w: event count exceeds bounds", ErrInvalidCompletionSource)
	}
	events := make([]Event, len(scheduled))
	for index := range scheduled {
		setEventBase(scheduled[index].event, EventBase{AtMillis: scheduled[index].at, Sequence: index + 1})
		events[index] = scheduled[index].event
	}

	assets := make([]Asset, len(materials))
	for index := range materials {
		assets[index] = materials[index].Asset
	}
	view := View{Layout: "grid", Sidebar: "chat"}
	if shared.Kind != "none" {
		view.Layout = "presentation"
	}
	timeline := Timeline{
		SchemaVersion: SchemaVersion,
		RecordingID:   source.RecordingID.String(),
		EpisodeID:     source.EpisodeID.String(),
		Clock: Clock{
			Origin: "capture_ready", Timebase: "recording_relative_ms",
			CaptureEpoch: source.CaptureEpoch, OriginAuthorityID: source.PresentationHandle.String(),
			DurationMillis: source.DurationMillis,
		},
		SourceCursors: SourceCursors{
			EpisodeControlStartRevision: source.EpisodeControlOriginRevision,
			EpisodeControlEndRevision:   controlEnd,
			ChatStartSequence:           source.ChatStartSequence,
			ChatEndSequence:             chatEnd,
			WhiteboardStartRevision:     source.WhiteboardOriginRevision,
			WhiteboardEndRevision:       whiteboardEnd,
			CapturePlanStartRevision:    source.CapturePlanStartRevision,
			CapturePlanEndRevision:      planEnd,
		},
		Initial: Snapshot{
			ElapsedMillis: 0,
			Profile:       source.Profile,
			Space:         Space{ID: source.SpaceID.String(), Name: source.SpaceName},
			View:          view,
			Participants:  participants,
			Media:         media,
			Chat: Chat{
				RetainedFloorSequence: cloneInt64(source.ChatRetainedFloorSequence),
				HeadSequence:          source.ChatStartSequence, Messages: initialChat,
			},
			SharedContent: shared,
			Reactions:     []Reaction{},
		},
		Events: events,
		Assets: assets,
	}
	if err := timeline.Validate(); err != nil {
		return builtPresentation{}, fmt.Errorf("%w: %v", ErrInvalidCompletionSource, err)
	}
	return builtPresentation{Timeline: timeline, Assets: materials}, nil
}

func validateCompletionSource(source CompletionSource) error {
	if source.PresentationHandle.IsZero() || source.TenantID.IsZero() || source.SpaceID.IsZero() ||
		source.EpisodeID.IsZero() || source.RecordingID.IsZero() || source.CaptureEpoch <= 0 ||
		source.CaptureReadyAt.IsZero() || source.DurationMillis <= 0 ||
		source.DurationMillis > maximumSafeInteger || !boundedString(source.SpaceName, 256) ||
		source.EpisodeControlStartRevision < 0 || source.EpisodeControlOriginRevision < source.EpisodeControlStartRevision ||
		source.ChatStartSequence < 0 || source.WhiteboardStartRevision < 0 ||
		source.WhiteboardOriginRevision < 0 || source.CapturePlanStartRevision < 0 ||
		len(source.BaselineControlState) == 0 {
		return ErrInvalidCompletionSource
	}
	if err := validateCapturePlanStream(source); err != nil {
		return err
	}
	if err := ValidateProfile(source.Profile); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidCompletionSource, err)
	}
	return nil
}

func validateCapturePlanStream(source CompletionSource) error {
	if source.CaptureEpoch > int64(recordingbundle.MaxTrackEpochCaptureEpoch) {
		return fmt.Errorf("%w: capture epoch exceeds track identity bounds", ErrInvalidCompletionSource)
	}
	previousCursor := int64(0)
	previousCaptureEpoch := int64(0)
	previousSourceRevision := int64(0)
	for _, fact := range source.CapturePlans {
		authority := fact.Plan.Authority()
		captureEpoch := int64(authority.CaptureEpoch)
		sourceRevision := int64(fact.Plan.Revision())
		if fact.Revision != previousCursor+1 || fact.Revision > maximumSafeInteger ||
			captureEpoch <= 0 || captureEpoch > source.CaptureEpoch ||
			sourceRevision <= 0 || uint64(sourceRevision) > recordingbundle.MaxTrackEpochPlanRevision ||
			captureEpoch < previousCaptureEpoch ||
			(captureEpoch == previousCaptureEpoch && sourceRevision != previousSourceRevision+1) ||
			(captureEpoch > previousCaptureEpoch && sourceRevision != 1) {
			return fmt.Errorf("%w: capture plan stream diverges", ErrInvalidCompletionSource)
		}
		previousCursor = fact.Revision
		previousCaptureEpoch = captureEpoch
		previousSourceRevision = sourceRevision
	}
	if len(source.CapturePlans) > 0 && previousCaptureEpoch != source.CaptureEpoch {
		return fmt.Errorf("%w: capture plan stream misses current epoch", ErrInvalidCompletionSource)
	}
	return nil
}

func elapsedMillis(source CompletionSource, at time.Time) (int64, error) {
	if at.IsZero() || at.Before(source.CaptureReadyAt) {
		return 0, fmt.Errorf("%w: event precedes recording origin", ErrInvalidCompletionSource)
	}
	elapsed := at.Sub(source.CaptureReadyAt) / time.Millisecond
	if elapsed < 0 || elapsed > time.Duration(source.DurationMillis) {
		return 0, fmt.Errorf("%w: event exceeds recording duration", ErrInvalidCompletionSource)
	}
	return int64(elapsed), nil
}

func setEventBase(event Event, base EventBase) {
	switch value := event.(type) {
	case *ParticipantJoinedEvent:
		value.EventBase = base
	case *ParticipantLeftEvent:
		value.EventBase = base
	case *ParticipantDisplayNameChangedEvent:
		value.EventBase = base
	case *ParticipantHandRaisedChangedEvent:
		value.EventBase = base
	case *ParticipantMicrophoneChangedEvent:
		value.EventBase = base
	case *ParticipantCameraChangedEvent:
		value.EventBase = base
	case *ParticipantScreenShareChangedEvent:
		value.EventBase = base
	case *ParticipantSpeakingChangedEvent:
		value.EventBase = base
	case *ActiveSpeakerChangedEvent:
		value.EventBase = base
	case *MediaSourceChangedEvent:
		value.EventBase = base
	case *ChatMessageAddedEvent:
		value.EventBase = base
	case *ReactionAddedEvent:
		value.EventBase = base
	case *SharedContentChangedEvent:
		value.EventBase = base
	default:
		panic("unknown recording presentation event type")
	}
}

func cloneInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
