package recordingpresentation

func (participant Participant) validate() error {
	if !boundedString(participant.ID, 512) || !boundedString(participant.DisplayName, 256) ||
		!positiveSafe(participant.JoinOrdinal) ||
		(participant.AvatarAssetID != "" && !boundedString(participant.AvatarAssetID, 512)) {
		return invalid("invalid presentation participant")
	}
	return nil
}

func (chat Chat) validate() error {
	if !nonnegativeSafe(chat.HeadSequence) || chat.Messages == nil || len(chat.Messages) > MaximumChatMessages {
		return invalid("invalid presentation chat")
	}
	if chat.RetainedFloorSequence != nil && !positiveSafe(*chat.RetainedFloorSequence) {
		return invalid("invalid chat retention floor")
	}
	messageIDs := make(map[string]struct{}, len(chat.Messages))
	for _, message := range chat.Messages {
		if err := message.validate(); err != nil {
			return err
		}
		if _, exists := messageIDs[message.ID]; exists {
			return invalid("duplicate chat message identity")
		}
		messageIDs[message.ID] = struct{}{}
	}
	return nil
}

func (message ChatMessage) validate() error {
	if !boundedString(message.ID, 512) || !positiveSafe(message.Sequence) ||
		!boundedString(message.ParticipantID, 512) || !boundedString(message.DisplayName, 256) ||
		len(message.Text) > 4_000 || !nonnegativeSafe(message.CreatedAtMillis) ||
		!boundedString(message.DisplayTime, 64) || message.Attachments == nil || len(message.Attachments) > 5 {
		return invalid("invalid presentation chat message")
	}
	attachmentIDs := make(map[string]struct{}, len(message.Attachments))
	for _, attachment := range message.Attachments {
		if !boundedString(attachment.ID, 512) || !boundedString(attachment.AssetID, 512) ||
			!boundedString(attachment.FileName, 255) || !boundedString(attachment.ContentType, 255) ||
			!positiveSafe(attachment.ByteSize) {
			return invalid("invalid presentation chat attachment")
		}
		if _, exists := attachmentIDs[attachment.ID]; exists {
			return invalid("duplicate chat attachment identity")
		}
		attachmentIDs[attachment.ID] = struct{}{}
	}
	return nil
}

func (reaction Reaction) validate() error {
	if !boundedString(reaction.ID, 512) || !boundedString(reaction.ParticipantID, 512) ||
		!boundedString(reaction.DisplayName, 256) || !nonnegativeSafe(reaction.OccurredAtMillis) ||
		!positiveSafe(reaction.ExpiresAtMillis) || reaction.ExpiresAtMillis <= reaction.OccurredAtMillis {
		return invalid("invalid presentation reaction")
	}
	if _, exists := reactionValues[reaction.Value]; !exists {
		return invalid("invalid presentation reaction value")
	}
	return nil
}

func (source MediaSource) validate(recordingID string) error {
	if !sourceIDPattern.MatchString(source.SourceID) || !boundedString(source.ParticipantID, 512) ||
		!positiveSafe(source.ParticipantGeneration) || !boundedString(source.TrackID, 512) || !positiveSafe(source.Epoch) {
		return invalid("invalid recording media source")
	}
	want, err := SourceID(MediaSourceIdentity{
		RecordingID: recordingID, ParticipantID: source.ParticipantID,
		ParticipantGeneration: source.ParticipantGeneration, Kind: source.Kind,
		TrackID: source.TrackID, Epoch: source.Epoch,
	})
	if err != nil || source.SourceID != want {
		return invalid("recording media source identity mismatch")
	}
	if source.Kind == MediaKindMicrophone && source.Visible {
		return invalid("microphone media sources cannot be visible")
	}
	return nil
}

func (content SharedContent) validate() error {
	switch content.Kind {
	case "none":
		if content.ParticipantID != "" || content.SourceID != "" || content.SceneID != "" || content.Revision != 0 || content.StateAssetID != "" {
			return invalid("none shared content has payload")
		}
	case "screen_share":
		if !boundedString(content.ParticipantID, 512) || !boundedString(content.SourceID, 512) ||
			content.SceneID != "" || content.Revision != 0 || content.StateAssetID != "" {
			return invalid("invalid shared screen content")
		}
	case "whiteboard":
		if !boundedString(content.SceneID, 512) || !nonnegativeSafe(content.Revision) ||
			!boundedString(content.StateAssetID, 512) || content.ParticipantID != "" || content.SourceID != "" {
			return invalid("invalid shared whiteboard content")
		}
	default:
		return invalid("invalid shared content kind")
	}
	return nil
}

func (asset Asset) validate() error {
	if !boundedString(asset.ID, 512) || !boundedString(asset.ObjectKey, 1024) ||
		!boundedString(asset.ContentType, 255) || !positiveSafe(asset.ByteSize) || !sha256Pattern.MatchString(asset.SHA256) {
		return invalid("invalid presentation asset")
	}
	if _, exists := assetKinds[asset.Kind]; !exists {
		return invalid("invalid presentation asset kind")
	}
	return nil
}
