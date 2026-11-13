package recordingpresentation

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"time"
)

func buildInitialChat(source CompletionSource, materials *[]assetMaterial, assetByID map[string]int) ([]ChatMessage, error) {
	messages := make([]ChatMessage, 0, min(len(source.InitialChatMessages), MaximumChatMessages))
	previous := int64(0)
	for index, fact := range source.InitialChatMessages {
		if fact.Sequence <= previous || fact.Sequence > source.ChatStartSequence || fact.CreatedAt.After(source.CaptureReadyAt) {
			return nil, fmt.Errorf("%w: invalid initial chat ordering", ErrInvalidCompletionSource)
		}
		previous = fact.Sequence
		if index < len(source.InitialChatMessages)-MaximumChatMessages {
			continue
		}
		message, err := buildChatMessage(source, fact, 0, materials, assetByID)
		if err != nil {
			return nil, err
		}
		messages = append(messages, message)
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
