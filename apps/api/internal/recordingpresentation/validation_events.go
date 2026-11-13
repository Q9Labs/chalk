package recordingpresentation

import "reflect"

func validateEvent(event Event, recordingID string, duration int64) (EventBase, string, []string, MediaSource, SharedContent, error) {
	if event == nil || (reflect.ValueOf(event).Kind() == reflect.Pointer && reflect.ValueOf(event).IsNil()) {
		return EventBase{}, "", nil, MediaSource{}, SharedContent{}, invalid("nil event")
	}
	base := event.eventBase()
	if !nonnegativeSafe(base.AtMillis) || base.AtMillis > duration || base.Sequence <= 0 {
		return base, "", nil, MediaSource{}, SharedContent{}, invalid("invalid event clock")
	}
	var kind string
	var references []string
	var source MediaSource
	var content SharedContent
	var err error
	switch value := event.(type) {
	case ParticipantJoinedEvent:
		kind, err = value.Kind, value.Participant.validate()
		if value.Participant.AvatarAssetID != "" {
			references = append(references, value.Participant.AvatarAssetID)
		}
	case *ParticipantJoinedEvent:
		if value == nil {
			return base, "", nil, source, content, invalid("nil event")
		}
		kind, err = value.Kind, value.Participant.validate()
		if value.Participant.AvatarAssetID != "" {
			references = append(references, value.Participant.AvatarAssetID)
		}
	case ParticipantLeftEvent:
		kind, err = value.Kind, requireID(value.ParticipantID)
	case *ParticipantLeftEvent:
		kind, err = value.Kind, requireID(value.ParticipantID)
	case ParticipantDisplayNameChangedEvent:
		kind = value.Kind
		if !boundedString(value.ParticipantID, 512) || !boundedString(value.DisplayName, 256) {
			err = invalid("invalid display name event")
		}
	case *ParticipantDisplayNameChangedEvent:
		kind = value.Kind
		if !boundedString(value.ParticipantID, 512) || !boundedString(value.DisplayName, 256) {
			err = invalid("invalid display name event")
		}
	case ParticipantHandRaisedChangedEvent:
		kind, err = value.Kind, requireID(value.ParticipantID)
	case *ParticipantHandRaisedChangedEvent:
		kind, err = value.Kind, requireID(value.ParticipantID)
	case ParticipantMicrophoneChangedEvent:
		kind, err = value.Kind, requireID(value.ParticipantID)
	case *ParticipantMicrophoneChangedEvent:
		kind, err = value.Kind, requireID(value.ParticipantID)
	case ParticipantCameraChangedEvent:
		kind, err = value.Kind, requireID(value.ParticipantID)
	case *ParticipantCameraChangedEvent:
		kind, err = value.Kind, requireID(value.ParticipantID)
	case ParticipantScreenShareChangedEvent:
		kind, err = value.Kind, requireID(value.ParticipantID)
	case *ParticipantScreenShareChangedEvent:
		kind, err = value.Kind, requireID(value.ParticipantID)
	case ParticipantSpeakingChangedEvent:
		kind, err = value.Kind, requireID(value.ParticipantID)
	case *ParticipantSpeakingChangedEvent:
		kind, err = value.Kind, requireID(value.ParticipantID)
	case ActiveSpeakerChangedEvent:
		kind = value.Kind
		if value.ParticipantID != nil {
			err = requireID(*value.ParticipantID)
		}
	case *ActiveSpeakerChangedEvent:
		kind = value.Kind
		if value.ParticipantID != nil {
			err = requireID(*value.ParticipantID)
		}
	case MediaSourceChangedEvent:
		kind, source = value.Kind, value.Source
		err = source.validate(recordingID)
	case *MediaSourceChangedEvent:
		kind, source = value.Kind, value.Source
		err = source.validate(recordingID)
	case ChatMessageAddedEvent:
		kind, err = value.Kind, value.Message.validate()
		for _, attachment := range value.Message.Attachments {
			references = append(references, attachment.AssetID)
		}
	case *ChatMessageAddedEvent:
		kind, err = value.Kind, value.Message.validate()
		for _, attachment := range value.Message.Attachments {
			references = append(references, attachment.AssetID)
		}
	case ReactionAddedEvent:
		kind, err = value.Kind, value.Reaction.validate()
	case *ReactionAddedEvent:
		kind, err = value.Kind, value.Reaction.validate()
	case SharedContentChangedEvent:
		kind, content, err = value.Kind, value.SharedContent, value.SharedContent.validate()
		if content.Kind == "whiteboard" {
			references = append(references, content.StateAssetID)
		}
	case *SharedContentChangedEvent:
		kind, content, err = value.Kind, value.SharedContent, value.SharedContent.validate()
		if content.Kind == "whiteboard" {
			references = append(references, content.StateAssetID)
		}
	default:
		err = invalid("unknown event type")
	}
	if err != nil {
		return base, kind, references, source, content, err
	}
	wantKind := eventKind(event)
	if kind != wantKind {
		return base, kind, references, source, content, invalid("event kind does not match payload")
	}
	return base, kind, references, source, content, nil
}

func eventKind(event Event) string {
	switch event.(type) {
	case ParticipantJoinedEvent, *ParticipantJoinedEvent:
		return "participant_joined"
	case ParticipantLeftEvent, *ParticipantLeftEvent:
		return "participant_left"
	case ParticipantDisplayNameChangedEvent, *ParticipantDisplayNameChangedEvent:
		return "participant_display_name_changed"
	case ParticipantHandRaisedChangedEvent, *ParticipantHandRaisedChangedEvent:
		return "participant_hand_raised_changed"
	case ParticipantMicrophoneChangedEvent, *ParticipantMicrophoneChangedEvent:
		return "participant_microphone_changed"
	case ParticipantCameraChangedEvent, *ParticipantCameraChangedEvent:
		return "participant_camera_changed"
	case ParticipantScreenShareChangedEvent, *ParticipantScreenShareChangedEvent:
		return "participant_screen_share_changed"
	case ParticipantSpeakingChangedEvent, *ParticipantSpeakingChangedEvent:
		return "participant_speaking_changed"
	case ActiveSpeakerChangedEvent, *ActiveSpeakerChangedEvent:
		return "active_speaker_changed"
	case MediaSourceChangedEvent, *MediaSourceChangedEvent:
		return "media_source_changed"
	case ChatMessageAddedEvent, *ChatMessageAddedEvent:
		return "chat_message_added"
	case ReactionAddedEvent, *ReactionAddedEvent:
		return "reaction_added"
	case SharedContentChangedEvent, *SharedContentChangedEvent:
		return "shared_content_changed"
	default:
		return ""
	}
}

func validateVisibleSources(sources map[string]MediaSource, shared SharedContent) error {
	visible := make(map[string]struct{})
	for _, source := range sources {
		if !source.Visible {
			continue
		}
		key := source.ParticipantID + "\x00" + string(source.Kind)
		if _, exists := visible[key]; exists {
			return invalid("ambiguous visible media sources")
		}
		visible[key] = struct{}{}
	}
	if shared.Kind != "screen_share" {
		return nil
	}
	source, exists := sources[shared.SourceID]
	if !exists || !source.Visible || source.Kind != MediaKindScreenShare || source.ParticipantID != shared.ParticipantID {
		return invalid("shared screen source does not resolve")
	}
	return nil
}
