package recordingpresentation

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

var (
	ErrInvalidTimeline      = errors.New("invalid recording presentation timeline")
	ErrUnknownSchemaVersion = errors.New("unknown recording presentation schema version")
	ErrTimelineTooLarge     = errors.New("recording presentation timeline exceeds bounds")
)

func Decode(input []byte) (Timeline, error) {
	if len(input) == 0 {
		return Timeline{}, ErrInvalidTimeline
	}
	if len(input) > MaximumTimelineSize {
		return Timeline{}, ErrTimelineTooLarge
	}

	var wire timelineWire
	if err := decodeStrict(input, &wire); err != nil {
		return Timeline{}, fmt.Errorf("%w: %v", ErrInvalidTimeline, err)
	}
	if wire.SchemaVersion != SchemaVersion {
		return Timeline{}, fmt.Errorf("%w: %q", ErrUnknownSchemaVersion, wire.SchemaVersion)
	}
	if wire.Events == nil {
		return Timeline{}, fmt.Errorf("%w: events must be an array", ErrInvalidTimeline)
	}
	if len(wire.Events) > MaximumEvents {
		return Timeline{}, ErrTimelineTooLarge
	}

	events := make([]Event, 0, len(wire.Events))
	for index, raw := range wire.Events {
		event, err := decodeEvent(raw)
		if err != nil {
			return Timeline{}, fmt.Errorf("%w: event %d: %v", ErrInvalidTimeline, index, err)
		}
		events = append(events, event)
	}
	timeline := Timeline{
		SchemaVersion: wire.SchemaVersion,
		RecordingID:   wire.RecordingID,
		EpisodeID:     wire.EpisodeID,
		Clock:         wire.Clock,
		SourceCursors: wire.SourceCursors,
		Initial:       wire.Initial,
		Events:        events,
		Assets:        wire.Assets,
	}
	if err := timeline.Validate(); err != nil {
		return Timeline{}, err
	}
	return timeline, nil
}

func Encode(timeline Timeline) ([]byte, error) {
	if err := timeline.Validate(); err != nil {
		return nil, err
	}
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(timeline); err != nil {
		return nil, fmt.Errorf("%w: encode: %v", ErrInvalidTimeline, err)
	}
	encoded := bytes.TrimSuffix(output.Bytes(), []byte("\n"))
	if len(encoded) > MaximumTimelineSize {
		return nil, ErrTimelineTooLarge
	}
	return append([]byte(nil), encoded...), nil
}

func (timeline Timeline) CanonicalBytes() ([]byte, error) { return Encode(timeline) }

func (timeline Timeline) MarshalJSON() ([]byte, error) {
	events := make([]any, len(timeline.Events))
	for index, event := range timeline.Events {
		if event == nil {
			return nil, fmt.Errorf("%w: nil event", ErrInvalidTimeline)
		}
		events[index] = event
	}
	wire := struct {
		SchemaVersion string        `json:"schemaVersion"`
		RecordingID   string        `json:"recordingId"`
		EpisodeID     string        `json:"episodeId"`
		Clock         Clock         `json:"clock"`
		SourceCursors SourceCursors `json:"sourceCursors"`
		Initial       Snapshot      `json:"initial"`
		Events        []any         `json:"events"`
		Assets        []Asset       `json:"assets"`
	}{
		SchemaVersion: timeline.SchemaVersion,
		RecordingID:   timeline.RecordingID,
		EpisodeID:     timeline.EpisodeID,
		Clock:         timeline.Clock,
		SourceCursors: timeline.SourceCursors,
		Initial:       timeline.Initial,
		Events:        events,
		Assets:        timeline.Assets,
	}
	return json.Marshal(wire)
}

func decodeEvent(raw json.RawMessage) (Event, error) {
	var header struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(raw, &header); err != nil || header.Kind == "" {
		return nil, errors.New("missing event kind")
	}

	var destination Event
	var keys []string
	switch header.Kind {
	case "participant_joined":
		destination = &ParticipantJoinedEvent{}
		keys = []string{"atMs", "sequence", "kind", "participant"}
	case "participant_left":
		destination = &ParticipantLeftEvent{}
		keys = []string{"atMs", "sequence", "kind", "participantId"}
	case "participant_display_name_changed":
		destination = &ParticipantDisplayNameChangedEvent{}
		keys = []string{"atMs", "sequence", "kind", "participantId", "displayName"}
	case "participant_hand_raised_changed":
		destination = &ParticipantHandRaisedChangedEvent{}
		keys = []string{"atMs", "sequence", "kind", "participantId", "raised"}
	case "participant_microphone_changed":
		destination = &ParticipantMicrophoneChangedEvent{}
		keys = []string{"atMs", "sequence", "kind", "participantId", "muted"}
	case "participant_camera_changed":
		destination = &ParticipantCameraChangedEvent{}
		keys = []string{"atMs", "sequence", "kind", "participantId", "enabled"}
	case "participant_screen_share_changed":
		destination = &ParticipantScreenShareChangedEvent{}
		keys = []string{"atMs", "sequence", "kind", "participantId", "enabled"}
	case "participant_speaking_changed":
		destination = &ParticipantSpeakingChangedEvent{}
		keys = []string{"atMs", "sequence", "kind", "participantId", "speaking"}
	case "active_speaker_changed":
		destination = &ActiveSpeakerChangedEvent{}
		keys = []string{"atMs", "sequence", "kind", "participantId"}
	case "media_source_changed":
		destination = &MediaSourceChangedEvent{}
		keys = []string{"atMs", "sequence", "kind", "source"}
	case "chat_message_added":
		destination = &ChatMessageAddedEvent{}
		keys = []string{"atMs", "sequence", "kind", "message"}
	case "reaction_added":
		destination = &ReactionAddedEvent{}
		keys = []string{"atMs", "sequence", "kind", "reaction"}
	case "shared_content_changed":
		destination = &SharedContentChangedEvent{}
		keys = []string{"atMs", "sequence", "kind", "sharedContent"}
	default:
		return nil, fmt.Errorf("unknown event kind %q", header.Kind)
	}
	if err := requireExactKeys(raw, keys); err != nil {
		return nil, err
	}
	if err := decodeStrict(raw, destination); err != nil {
		return nil, err
	}
	return destination, nil
}

func decodeStrict(input []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func requireExactKeys(input []byte, required []string) error {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(input, &object); err != nil {
		return err
	}
	if len(object) != len(required) {
		return errors.New("unexpected event fields")
	}
	for _, key := range required {
		if _, exists := object[key]; !exists {
			return fmt.Errorf("missing event field %q", key)
		}
	}
	return nil
}
