package recordingpresentation

import (
	"encoding/json"
	"fmt"
	"time"
)

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
		var emitted []Event
		if err := applyControlFact(participants, fact, func(event Event) { emitted = append(emitted, event) }); err != nil {
			return 0, err
		}
		previous = fact.Revision
		// Lifecycle facts can follow the frozen cursor while predating the
		// worker's capture-ready clock. Only presentation events need an offset.
		if len(emitted) == 0 {
			continue
		}
		at, err := elapsedMillis(source, fact.CreatedAt)
		if err != nil {
			return 0, err
		}
		for _, event := range emitted {
			appendEvent(at, 10, event)
		}
	}
	return previous, nil
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
