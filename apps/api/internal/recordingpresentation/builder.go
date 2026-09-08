package recordingpresentation

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

const whiteboardStateSchemaVersion = "recording_whiteboard_state.v1"

type assetMaterial struct {
	Asset    Asset
	Existing *ObjectFact
	Body     []byte
}

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

type controlSnapshotWire struct {
	ControlRevision int64                    `json:"control_revision"`
	Participants    []controlParticipantWire `json:"participants"`
}

type controlParticipantWire struct {
	ID                string `json:"participant_id"`
	DisplayName       string `json:"display_name"`
	HandRaised        bool   `json:"hand_raised"`
	AdmissionRevision int64  `json:"admission_revision"`
}

type joinedPayload struct {
	ID                string `json:"participant_id"`
	DisplayName       string `json:"display_name"`
	AdmissionRevision int64  `json:"admission_revision"`
}

type participantPayload struct {
	ID string `json:"participant_id"`
}

type displayNamePayload struct {
	ID          string `json:"participant_id"`
	DisplayName string `json:"display_name"`
}

type whiteboardElementWire struct {
	ID           string          `json:"id"`
	Type         string          `json:"type"`
	Version      int64           `json:"version"`
	VersionNonce int64           `json:"version_nonce"`
	Index        string          `json:"index"`
	Deleted      bool            `json:"is_deleted"`
	Payload      json.RawMessage `json:"payload"`
}

type whiteboardState struct {
	SceneID    string
	Revision   int64
	Presenting bool
	AppState   json.RawMessage
	Elements   map[string]whiteboardElementWire
}

type whiteboardStateWire struct {
	SchemaVersion string                  `json:"schemaVersion"`
	SceneID       string                  `json:"sceneId"`
	Revision      int64                   `json:"revision"`
	AppState      json.RawMessage         `json:"appState"`
	Elements      []whiteboardElementWire `json:"elements"`
}

type activeTrack struct {
	key          string
	captureEpoch int64
	binding      captureplane.CaptureTrack
	source       MediaSource
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

func controlParticipantsAtOrigin(source CompletionSource) (map[string]Participant, error) {
	return controlParticipantsAtRevision(source, source.EpisodeControlOriginRevision)
}

func controlParticipantsAtRevision(source CompletionSource, targetRevision int64) (map[string]Participant, error) {
	if targetRevision < source.EpisodeControlStartRevision || targetRevision > source.EpisodeControlOriginRevision {
		return nil, fmt.Errorf("%w: capture plan control cursor outside origin range", ErrInvalidCompletionSource)
	}
	var snapshot controlSnapshotWire
	if err := json.Unmarshal(source.BaselineControlState, &snapshot); err != nil || snapshot.ControlRevision != source.EpisodeControlStartRevision || snapshot.Participants == nil {
		return nil, fmt.Errorf("%w: invalid baseline control state", ErrInvalidCompletionSource)
	}
	participants := make(map[string]Participant, len(snapshot.Participants))
	for _, value := range snapshot.Participants {
		participant := Participant{
			ID: value.ID, DisplayName: value.DisplayName, JoinOrdinal: value.AdmissionRevision,
			Joined: true, MicrophoneMuted: true, HandRaised: value.HandRaised,
		}
		if err := participant.validate(); err != nil {
			return nil, fmt.Errorf("%w: invalid baseline participant", ErrInvalidCompletionSource)
		}
		if _, exists := participants[value.ID]; exists {
			return nil, fmt.Errorf("%w: duplicate baseline participant", ErrInvalidCompletionSource)
		}
		participants[value.ID] = participant
	}
	var targetParticipants map[string]Participant
	if targetRevision == source.EpisodeControlStartRevision {
		targetParticipants = cloneParticipants(participants)
	}
	previous := source.EpisodeControlStartRevision
	for _, event := range source.EpisodeControlOriginEvents {
		if event.Revision != previous+1 || event.CreatedAt.After(source.CaptureReadyAt) {
			return nil, fmt.Errorf("%w: control origin gap", ErrInvalidCompletionSource)
		}
		if err := applyControlFact(participants, event, nil); err != nil {
			return nil, err
		}
		previous = event.Revision
		if previous == targetRevision {
			targetParticipants = cloneParticipants(participants)
		}
	}
	if previous != source.EpisodeControlOriginRevision {
		return nil, fmt.Errorf("%w: control origin cursor mismatch", ErrInvalidCompletionSource)
	}
	if targetParticipants == nil {
		return nil, fmt.Errorf("%w: capture plan control cursor missing from origin", ErrInvalidCompletionSource)
	}
	return targetParticipants, nil
}

func cloneParticipants(source map[string]Participant) map[string]Participant {
	result := make(map[string]Participant, len(source))
	for id, participant := range source {
		result[id] = participant
	}
	return result
}

func applyControlFact(participants map[string]Participant, fact ControlEventFact, emit func(Event)) error {
	switch fact.Name {
	case "participant_joined":
		var payload joinedPayload
		if err := json.Unmarshal(fact.Payload, &payload); err != nil {
			return fmt.Errorf("%w: decode participant join", ErrInvalidCompletionSource)
		}
		if _, exists := participants[payload.ID]; exists {
			return fmt.Errorf("%w: duplicate participant join", ErrInvalidCompletionSource)
		}
		participant := Participant{ID: payload.ID, DisplayName: payload.DisplayName, JoinOrdinal: payload.AdmissionRevision, Joined: true, MicrophoneMuted: true}
		if err := participant.validate(); err != nil {
			return fmt.Errorf("%w: invalid participant join", ErrInvalidCompletionSource)
		}
		participants[payload.ID] = participant
		if emit != nil {
			emit(&ParticipantJoinedEvent{Kind: "participant_joined", Participant: participant})
		}
	case "participant_left":
		var payload participantPayload
		if err := json.Unmarshal(fact.Payload, &payload); err != nil || payload.ID == "" {
			return fmt.Errorf("%w: decode participant leave", ErrInvalidCompletionSource)
		}
		participant, exists := participants[payload.ID]
		if !exists {
			return fmt.Errorf("%w: unknown participant leave", ErrInvalidCompletionSource)
		}
		participant.Joined = false
		participant.CameraEnabled = false
		participant.ScreenShareEnabled = false
		participant.Speaking = false
		participant.ActiveSpeaker = false
		participants[payload.ID] = participant
		if emit != nil {
			emit(&ParticipantLeftEvent{Kind: "participant_left", ParticipantID: payload.ID})
		}
	case "participant_display_name_changed":
		var payload displayNamePayload
		if err := json.Unmarshal(fact.Payload, &payload); err != nil || !boundedString(payload.DisplayName, 256) {
			return fmt.Errorf("%w: decode participant display name", ErrInvalidCompletionSource)
		}
		participant, exists := participants[payload.ID]
		if !exists {
			return fmt.Errorf("%w: unknown participant display name", ErrInvalidCompletionSource)
		}
		participant.DisplayName = payload.DisplayName
		participants[payload.ID] = participant
		if emit != nil {
			emit(&ParticipantDisplayNameChangedEvent{Kind: "participant_display_name_changed", ParticipantID: payload.ID, DisplayName: payload.DisplayName})
		}
	case "hand_raised", "hand_lowered":
		var payload participantPayload
		if err := json.Unmarshal(fact.Payload, &payload); err != nil || payload.ID == "" {
			return fmt.Errorf("%w: decode participant hand state", ErrInvalidCompletionSource)
		}
		participant, exists := participants[payload.ID]
		if !exists {
			return fmt.Errorf("%w: unknown participant hand state", ErrInvalidCompletionSource)
		}
		participant.HandRaised = fact.Name == "hand_raised"
		participants[payload.ID] = participant
		if emit != nil {
			emit(&ParticipantHandRaisedChangedEvent{Kind: "participant_hand_raised_changed", ParticipantID: payload.ID, Raised: participant.HandRaised})
		}
	}
	return nil
}

func scheduleControlTail(source CompletionSource, appendEvent func(int64, int, Event)) (int64, error) {
	participants, err := controlParticipantsAtOrigin(source)
	if err != nil {
		return 0, err
	}
	previous := source.EpisodeControlOriginRevision
	for _, fact := range source.EpisodeControlTailEvents {
		if fact.Revision != previous+1 {
			return 0, fmt.Errorf("%w: control tail gap", ErrInvalidCompletionSource)
		}
		at, err := elapsedMillis(source, fact.CreatedAt)
		if err != nil {
			return 0, err
		}
		var emitted []Event
		if err := applyControlFact(participants, fact, func(event Event) { emitted = append(emitted, event) }); err != nil {
			return 0, err
		}
		for _, event := range emitted {
			appendEvent(at, 10, event)
		}
		previous = fact.Revision
	}
	return previous, nil
}

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

func screenSharedContent(active map[string]activeTrack) SharedContent {
	var screen *MediaSource
	for _, track := range active {
		if track.source.Kind != MediaKindScreenShare || !track.source.Visible {
			continue
		}
		candidate := track.source
		if screen == nil || candidate.ParticipantID < screen.ParticipantID {
			screen = &candidate
		}
	}
	if screen == nil {
		return SharedContent{Kind: "none"}
	}
	return SharedContent{Kind: "screen_share", ParticipantID: screen.ParticipantID, SourceID: screen.SourceID}
}

func schedulePlanTail(source CompletionSource, active map[string]activeTrack, originRevision int64, appendEvent func(int64, int, Event)) (map[string]activeTrack, int64, error) {
	previousRevision := int64(0)
	endRevision := originRevision
	for _, fact := range source.CapturePlans {
		if fact.Revision != previousRevision+1 {
			return nil, 0, fmt.Errorf("%w: capture plan gap", ErrInvalidCompletionSource)
		}
		previousRevision = fact.Revision
		if fact.Revision <= source.CapturePlanStartRevision {
			continue
		}
		at, err := elapsedMillis(source, fact.CreatedAt)
		if err != nil {
			return nil, 0, err
		}
		desired, err := tracksForPlan(source, fact, active)
		if err != nil {
			return nil, 0, err
		}
		keys := unionTrackKeys(active, desired)
		for _, key := range keys {
			prior, hadPrior := active[key]
			next, hasNext := desired[key]
			if hadPrior && (!hasNext || prior.source.SourceID != next.source.SourceID) {
				hidden := prior.source
				hidden.Visible = false
				if prior.source.Visible {
					appendEvent(at, 20, &MediaSourceChangedEvent{Kind: "media_source_changed", Source: hidden})
				}
				appendParticipantMediaState(at, prior.source.ParticipantID, prior.source.Kind, false, appendEvent)
			}
			if hasNext && (!hadPrior || prior.source.SourceID != next.source.SourceID) {
				appendEvent(at, 20, &MediaSourceChangedEvent{Kind: "media_source_changed", Source: next.source})
				appendParticipantMediaState(at, next.source.ParticipantID, next.source.Kind, true, appendEvent)
			}
		}
		if !whiteboardPresentedAt(source, fact.CreatedAt) {
			priorShared := screenSharedContent(active)
			nextShared := screenSharedContent(desired)
			if priorShared != nextShared {
				appendEvent(at, 22, &SharedContentChangedEvent{Kind: "shared_content_changed", SharedContent: nextShared})
			}
		}
		active = desired
		endRevision = fact.Revision
	}
	return active, endRevision, nil
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

func buildInitialChat(source CompletionSource, materials *[]assetMaterial, assetByID map[string]int) ([]ChatMessage, error) {
	messages := make([]ChatMessage, 0, len(source.InitialChatMessages))
	previous := int64(0)
	for _, fact := range source.InitialChatMessages {
		if fact.Sequence <= previous || fact.Sequence > source.ChatStartSequence || fact.CreatedAt.After(source.CaptureReadyAt) {
			return nil, fmt.Errorf("%w: invalid initial chat ordering", ErrInvalidCompletionSource)
		}
		message, err := buildChatMessage(source, fact, 0, materials, assetByID)
		if err != nil {
			return nil, err
		}
		messages = append(messages, message)
		previous = fact.Sequence
	}
	if len(messages) > MaximumChatMessages {
		return nil, fmt.Errorf("%w: initial chat exceeds bounds", ErrInvalidCompletionSource)
	}
	return messages, nil
}

func scheduleChatTail(source CompletionSource, materials *[]assetMaterial, assetByID map[string]int, appendEvent func(int64, int, Event)) (int64, error) {
	end := source.ChatStartSequence
	for _, fact := range source.ChatTailMessages {
		if fact.Sequence <= end {
			return 0, fmt.Errorf("%w: invalid chat tail ordering", ErrInvalidCompletionSource)
		}
		at, err := elapsedMillis(source, fact.CreatedAt)
		if err != nil {
			return 0, err
		}
		message, err := buildChatMessage(source, fact, at, materials, assetByID)
		if err != nil {
			return 0, err
		}
		appendEvent(at, 30, &ChatMessageAddedEvent{Kind: "chat_message_added", Message: message})
		end = fact.Sequence
	}
	return end, nil
}

func buildChatMessage(source CompletionSource, fact ChatMessageFact, createdAtMillis int64, materials *[]assetMaterial, assetByID map[string]int) (ChatMessage, error) {
	attachments := make([]Attachment, 0, len(fact.Attachments))
	for _, fact := range fact.Attachments {
		assetID := "chat_attachment:" + fact.ID
		digest := hex.EncodeToString(fact.Object.SHA256)
		asset := Asset{
			ID: assetID, Kind: "chat_attachment",
			ObjectKey:   existingAssetObjectKey(source, assetID, "chat_attachment", digest),
			ContentType: fact.Object.ContentType, ByteSize: fact.Object.ByteSize,
			SHA256: digest,
		}
		if err := addAssetMaterial(assetMaterial{Asset: asset, Existing: cloneObjectFactPointer(fact.Object)}, materials, assetByID); err != nil {
			return ChatMessage{}, err
		}
		attachments = append(attachments, Attachment{
			ID: fact.ID, AssetID: assetID, FileName: fact.FileName,
			ContentType: fact.Object.ContentType, ByteSize: fact.Object.ByteSize,
		})
	}
	message := ChatMessage{
		ID: fact.ID, Sequence: fact.Sequence, ParticipantID: fact.ParticipantID,
		DisplayName: fact.DisplayName, Text: fact.Text, CreatedAtMillis: createdAtMillis,
		DisplayTime: fact.CreatedAt.UTC().Format("15:04"), Attachments: attachments,
	}
	if err := message.validate(); err != nil {
		return ChatMessage{}, fmt.Errorf("%w: invalid chat message", ErrInvalidCompletionSource)
	}
	return message, nil
}

func addAssetMaterial(material assetMaterial, materials *[]assetMaterial, assetByID map[string]int) error {
	if priorIndex, exists := assetByID[material.Asset.ID]; exists {
		prior := (*materials)[priorIndex]
		if prior.Asset != material.Asset || !sameOptionalObject(prior.Existing, material.Existing) || !bytes.Equal(prior.Body, material.Body) {
			return fmt.Errorf("%w: conflicting asset identity", ErrInvalidCompletionSource)
		}
		return nil
	}
	if len(*materials) >= MaximumAssets {
		return fmt.Errorf("%w: asset count exceeds bounds", ErrInvalidCompletionSource)
	}
	assetByID[material.Asset.ID] = len(*materials)
	*materials = append(*materials, material)
	return nil
}

func sameOptionalObject(left, right *ObjectFact) bool {
	if left == nil || right == nil {
		return left == right
	}
	return left.Key == right.Key && left.Version == right.Version && left.ETag == right.ETag &&
		left.ContentType == right.ContentType && left.ByteSize == right.ByteSize && bytes.Equal(left.SHA256, right.SHA256)
}

func cloneObjectFactPointer(value ObjectFact) *ObjectFact {
	copy := value
	copy.SHA256 = append([]byte(nil), value.SHA256...)
	return &copy
}

func scheduleReactions(source CompletionSource, appendEvent func(int64, int, Event)) error {
	seen := make(map[string]struct{}, len(source.Reactions))
	for _, fact := range source.Reactions {
		if _, exists := seen[fact.ID]; exists {
			return fmt.Errorf("%w: duplicate reaction", ErrInvalidCompletionSource)
		}
		seen[fact.ID] = struct{}{}
		at, err := elapsedMillis(source, fact.OccurredAt)
		if err != nil {
			return err
		}
		expires := int64(fact.ExpiresAt.Sub(source.CaptureReadyAt) / time.Millisecond)
		if expires <= at || expires > maximumSafeInteger {
			return fmt.Errorf("%w: invalid reaction interval", ErrInvalidCompletionSource)
		}
		reaction := Reaction{
			ID: fact.ID, ParticipantID: fact.ParticipantID, DisplayName: fact.DisplayName,
			Value: fact.Value, OccurredAtMillis: at, ExpiresAtMillis: expires,
		}
		appendEvent(at, 50, &ReactionAddedEvent{Kind: "reaction_added", Reaction: reaction})
	}
	return nil
}

func whiteboardAtOrigin(source CompletionSource) (*whiteboardState, error) {
	state, err := newWhiteboardState(source.InitialWhiteboard)
	if err != nil {
		return nil, err
	}
	cursor := source.WhiteboardStartRevision
	for _, fact := range source.WhiteboardOriginEvents {
		if fact.CompletedAt.After(source.CaptureReadyAt) {
			return nil, fmt.Errorf("%w: whiteboard origin event after origin", ErrInvalidCompletionSource)
		}
		state, err = applyWhiteboardFact(state, fact)
		if err != nil {
			return nil, err
		}
		if fact.Revision > cursor {
			cursor = fact.Revision
		}
	}
	if cursor != source.WhiteboardOriginRevision {
		return nil, fmt.Errorf("%w: whiteboard origin cursor mismatch", ErrInvalidCompletionSource)
	}
	return state, nil
}

func newWhiteboardState(snapshot *WhiteboardSnapshotFact) (*whiteboardState, error) {
	if snapshot == nil {
		return nil, nil
	}
	if snapshot.SceneID == "" || snapshot.Revision < 0 || len(snapshot.AppState) == 0 {
		return nil, fmt.Errorf("%w: invalid whiteboard snapshot", ErrInvalidCompletionSource)
	}
	state := &whiteboardState{
		SceneID: snapshot.SceneID, Revision: snapshot.Revision, Presenting: snapshot.Presenting,
		AppState: append(json.RawMessage(nil), snapshot.AppState...), Elements: make(map[string]whiteboardElementWire, len(snapshot.Elements)),
	}
	for _, raw := range snapshot.Elements {
		element, err := decodeWhiteboardElement(raw)
		if err != nil {
			return nil, err
		}
		if _, exists := state.Elements[element.ID]; exists {
			return nil, fmt.Errorf("%w: duplicate whiteboard element", ErrInvalidCompletionSource)
		}
		state.Elements[element.ID] = element
	}
	return state, nil
}

func applyWhiteboardFact(state *whiteboardState, fact WhiteboardEventFact) (*whiteboardState, error) {
	if fact.OperationID == "" || fact.SceneID == "" || fact.Revision < 0 || fact.CompletedAt.IsZero() {
		return nil, fmt.Errorf("%w: invalid whiteboard event", ErrInvalidCompletionSource)
	}
	switch fact.Name {
	case "clear":
		presenting := false
		if state != nil {
			presenting = state.Presenting
		}
		if fact.Revision != 0 || len(fact.Elements) != 0 || fact.Presenting != nil {
			return nil, fmt.Errorf("%w: invalid whiteboard clear", ErrInvalidCompletionSource)
		}
		return &whiteboardState{SceneID: fact.SceneID, Revision: 0, Presenting: presenting, AppState: json.RawMessage(`{}`), Elements: make(map[string]whiteboardElementWire)}, nil
	case "set_draw_permission":
		if len(fact.Elements) != 0 || fact.Presenting != nil {
			return nil, fmt.Errorf("%w: invalid whiteboard permission event", ErrInvalidCompletionSource)
		}
		return state, nil
	case "submit_update", "set_presentation":
		if state == nil {
			if fact.Revision != 1 {
				return nil, fmt.Errorf("%w: missing whiteboard state", ErrInvalidCompletionSource)
			}
			state = &whiteboardState{SceneID: fact.SceneID, Revision: 0, AppState: json.RawMessage(`{}`), Elements: make(map[string]whiteboardElementWire)}
		}
		if state.SceneID != fact.SceneID || fact.Revision != state.Revision+1 {
			return nil, fmt.Errorf("%w: whiteboard revision gap", ErrInvalidCompletionSource)
		}
		next := cloneWhiteboardState(state)
		next.Revision = fact.Revision
		if fact.Name == "set_presentation" {
			if fact.Presenting == nil || len(fact.Elements) != 0 {
				return nil, fmt.Errorf("%w: invalid whiteboard presentation event", ErrInvalidCompletionSource)
			}
			next.Presenting = *fact.Presenting
			return next, nil
		}
		if fact.Presenting != nil {
			return nil, fmt.Errorf("%w: invalid whiteboard update event", ErrInvalidCompletionSource)
		}
		for _, raw := range fact.Elements {
			element, err := decodeWhiteboardElement(raw)
			if err != nil {
				return nil, err
			}
			if existing, exists := next.Elements[element.ID]; !exists || whiteboardElementWins(element, existing) {
				next.Elements[element.ID] = element
			}
		}
		return next, nil
	default:
		return nil, fmt.Errorf("%w: unknown whiteboard operation", ErrInvalidCompletionSource)
	}
}

func cloneWhiteboardState(source *whiteboardState) *whiteboardState {
	result := &whiteboardState{
		SceneID: source.SceneID, Revision: source.Revision, Presenting: source.Presenting,
		AppState: append(json.RawMessage(nil), source.AppState...), Elements: make(map[string]whiteboardElementWire, len(source.Elements)),
	}
	for id, element := range source.Elements {
		element.Payload = append(json.RawMessage(nil), element.Payload...)
		result.Elements[id] = element
	}
	return result
}

func decodeWhiteboardElement(raw json.RawMessage) (whiteboardElementWire, error) {
	var element whiteboardElementWire
	if err := json.Unmarshal(raw, &element); err != nil || element.ID == "" || element.Type == "" ||
		element.Version < 0 || element.VersionNonce < 0 || element.Index == "" || len(element.Payload) == 0 {
		return whiteboardElementWire{}, fmt.Errorf("%w: invalid whiteboard element", ErrInvalidCompletionSource)
	}
	return element, nil
}

func whiteboardElementWins(candidate, existing whiteboardElementWire) bool {
	return candidate.Version > existing.Version || (candidate.Version == existing.Version && candidate.VersionNonce < existing.VersionNonce)
}

func addWhiteboardStateAsset(state whiteboardState, source CompletionSource, materials *[]assetMaterial, assetByID map[string]int) (string, error) {
	elements := make([]whiteboardElementWire, 0, len(state.Elements))
	for _, element := range state.Elements {
		elements = append(elements, element)
	}
	sort.Slice(elements, func(i, j int) bool {
		if elements[i].Index != elements[j].Index {
			return elements[i].Index < elements[j].Index
		}
		return elements[i].ID < elements[j].ID
	})
	if err := validateWhiteboardFileReferences(elements, assetByID); err != nil {
		return "", err
	}
	body, err := json.Marshal(whiteboardStateWire{
		SchemaVersion: whiteboardStateSchemaVersion, SceneID: state.SceneID,
		Revision: state.Revision, AppState: state.AppState, Elements: elements,
	})
	if err != nil {
		return "", fmt.Errorf("%w: encode whiteboard state", ErrInvalidCompletionSource)
	}
	digest := sha256.Sum256(body)
	digestHex := hex.EncodeToString(digest[:])
	assetID := fmt.Sprintf("whiteboard_state:%s:%d", state.SceneID, state.Revision)
	asset := Asset{
		ID: assetID, Kind: "whiteboard_state",
		ObjectKey:   presentationObjectPrefix(source) + "/assets/whiteboard-state-" + digestHex + ".json",
		ContentType: "application/json", ByteSize: int64(len(body)), SHA256: digestHex,
	}
	if err := addAssetMaterial(assetMaterial{Asset: asset, Body: body}, materials, assetByID); err != nil {
		return "", err
	}
	return assetID, nil
}

func addWhiteboardFileAssets(source CompletionSource, materials *[]assetMaterial, assetByID map[string]int) error {
	for _, file := range source.WhiteboardFiles {
		assetID := "whiteboard_file:" + file.ID
		digest := hex.EncodeToString(file.Object.SHA256)
		asset := Asset{
			ID: assetID, Kind: "whiteboard_file",
			ObjectKey:   existingAssetObjectKey(source, assetID, "whiteboard_file", digest),
			ContentType: file.Object.ContentType, ByteSize: file.Object.ByteSize,
			SHA256: digest,
		}
		if err := addAssetMaterial(assetMaterial{Asset: asset, Existing: cloneObjectFactPointer(file.Object)}, materials, assetByID); err != nil {
			return err
		}
	}
	return nil
}

func validateWhiteboardFileReferences(elements []whiteboardElementWire, assetByID map[string]int) error {
	for _, element := range elements {
		if element.Deleted {
			continue
		}
		var payload map[string]json.RawMessage
		if err := json.Unmarshal(element.Payload, &payload); err != nil {
			return fmt.Errorf("%w: invalid whiteboard element payload", ErrInvalidCompletionSource)
		}
		raw, exists := payload["fileId"]
		if !exists || bytes.Equal(raw, []byte("null")) {
			continue
		}
		var fileID string
		if err := json.Unmarshal(raw, &fileID); err != nil || fileID == "" {
			return fmt.Errorf("%w: invalid whiteboard file identity", ErrInvalidCompletionSource)
		}
		if _, exists := assetByID["whiteboard_file:"+fileID]; !exists {
			return fmt.Errorf("%w: missing whiteboard file asset", ErrInvalidCompletionSource)
		}
	}
	return nil
}

func scheduleWhiteboardTail(source CompletionSource, state *whiteboardState, _ map[string]activeTrack, materials *[]assetMaterial, assetByID map[string]int, appendEvent func(int64, int, Event)) (int64, error) {
	cursor := source.WhiteboardOriginRevision
	var err error
	for _, fact := range source.WhiteboardTailEvents {
		at, elapsedErr := elapsedMillis(source, fact.CompletedAt)
		if elapsedErr != nil {
			return 0, elapsedErr
		}
		before := state
		state, err = applyWhiteboardFact(state, fact)
		if err != nil {
			return 0, err
		}
		if fact.Revision > cursor {
			cursor = fact.Revision
		}
		if state == before || state == nil {
			continue
		}
		if state.Presenting {
			assetID, addErr := addWhiteboardStateAsset(*state, source, materials, assetByID)
			if addErr != nil {
				return 0, addErr
			}
			appendEvent(at, 42, &SharedContentChangedEvent{Kind: "shared_content_changed", SharedContent: SharedContent{
				Kind: "whiteboard", SceneID: state.SceneID, Revision: state.Revision, StateAssetID: assetID,
			}})
		} else if before != nil && before.Presenting {
			fallback, fallbackErr := screenSharedAt(source, fact.CompletedAt)
			if fallbackErr != nil {
				return 0, fallbackErr
			}
			appendEvent(at, 42, &SharedContentChangedEvent{Kind: "shared_content_changed", SharedContent: fallback})
		}
	}
	return cursor, nil
}

func whiteboardPresentedAt(source CompletionSource, at time.Time) bool {
	state, err := whiteboardAtOrigin(source)
	if err != nil {
		return false
	}
	if at.Before(source.CaptureReadyAt) {
		return state != nil && state.Presenting
	}
	for _, fact := range source.WhiteboardTailEvents {
		if fact.CompletedAt.After(at) {
			break
		}
		state, err = applyWhiteboardFact(state, fact)
		if err != nil {
			return false
		}
	}
	return state != nil && state.Presenting
}

func screenSharedAt(source CompletionSource, at time.Time) (SharedContent, error) {
	active := make(map[string]activeTrack)
	previous := int64(0)
	for _, fact := range source.CapturePlans {
		if fact.Revision != previous+1 {
			return SharedContent{}, fmt.Errorf("%w: capture plan gap", ErrInvalidCompletionSource)
		}
		previous = fact.Revision
		if fact.CreatedAt.After(at) {
			break
		}
		var err error
		active, err = tracksForPlan(source, fact, active)
		if err != nil {
			return SharedContent{}, err
		}
	}
	participants, err := controlParticipantsAtTime(source, at)
	if err != nil {
		return SharedContent{}, err
	}
	if err := hideDepartedMedia(participants, active); err != nil {
		return SharedContent{}, err
	}
	return screenSharedContent(active), nil
}

func controlParticipantsAtTime(source CompletionSource, at time.Time) (map[string]Participant, error) {
	participants, err := controlParticipantsAtOrigin(source)
	if err != nil {
		return nil, err
	}
	previous := source.EpisodeControlOriginRevision
	for _, fact := range source.EpisodeControlTailEvents {
		if fact.Revision != previous+1 {
			return nil, fmt.Errorf("%w: control tail gap", ErrInvalidCompletionSource)
		}
		previous = fact.Revision
		if fact.CreatedAt.After(at) {
			continue
		}
		if err := applyControlFact(participants, fact, nil); err != nil {
			return nil, err
		}
	}
	return participants, nil
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

func presentationObjectPrefix(source CompletionSource) string {
	return fmt.Sprintf(
		"tenants/%s/recordings/%s/presentation/%d/%s",
		source.TenantID.String(), source.RecordingID.String(), source.CaptureEpoch,
		source.PresentationHandle.String(),
	)
}

func existingAssetObjectKey(source CompletionSource, assetID, kind, digest string) string {
	identity := sha256.Sum256([]byte(assetID))
	return fmt.Sprintf(
		"%s/assets/%s-%s-%s",
		presentationObjectPrefix(source), kind, digest, hex.EncodeToString(identity[:]),
	)
}

func cloneInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
