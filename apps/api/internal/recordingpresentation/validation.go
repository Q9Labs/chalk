package recordingpresentation

import (
	"fmt"
	"math"
	"reflect"
	"regexp"
)

var sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var sourceIDPattern = regexp.MustCompile(`^rps_[0-9a-f]{64}$`)

var themePalettes = map[string]struct{}{
	"light": {}, "warm-porcelain": {}, "cool-mist": {}, "paper-and-ink": {},
	"cream-and-clay": {}, "studio-canvas": {}, "prism-daylight": {}, "signal-white": {},
	"warm-charcoal": {}, "cool-graphite": {}, "high-contrast-ink": {}, "espresso-night": {},
	"chalkboard-atelier": {}, "prism-nocturne": {}, "cosmic-chalk": {}, "oled-signal": {},
}

var reactionValues = map[string]struct{}{"👍": {}, "❤️": {}, "😂": {}, "😮": {}, "😢": {}, "🎉": {}}
var assetKinds = map[string]struct{}{
	"logo": {}, "avatar": {}, "chat_attachment": {}, "whiteboard_state": {}, "whiteboard_file": {}, "font": {},
}

func ValidateProfile(profile Profile) error { return profile.validate() }

func (timeline Timeline) Validate() error {
	if timeline.SchemaVersion != SchemaVersion {
		return fmt.Errorf("%w: schema version %q", ErrUnknownSchemaVersion, timeline.SchemaVersion)
	}
	if !boundedString(timeline.RecordingID, 512) || !boundedString(timeline.EpisodeID, 512) {
		return invalid("recording and episode identities are required")
	}
	if err := timeline.Clock.validate(); err != nil {
		return err
	}
	if err := timeline.SourceCursors.validate(); err != nil {
		return err
	}
	if err := timeline.Initial.validate(timeline.RecordingID); err != nil {
		return err
	}
	if timeline.Initial.ElapsedMillis != 0 {
		return invalid("initial elapsed time must be zero")
	}
	if timeline.Events == nil || len(timeline.Events) > MaximumEvents {
		return invalid("event count exceeds bounds")
	}
	if timeline.Assets == nil || len(timeline.Assets) > MaximumAssets {
		return invalid("asset count exceeds bounds")
	}

	assetIDs := make(map[string]struct{}, len(timeline.Assets))
	for index, asset := range timeline.Assets {
		if err := asset.validate(); err != nil {
			return fmt.Errorf("%w: asset %d: %v", ErrInvalidTimeline, index, err)
		}
		if _, exists := assetIDs[asset.ID]; exists {
			return invalid("duplicate asset identity")
		}
		assetIDs[asset.ID] = struct{}{}
	}
	references := timeline.Initial.assetReferences()

	sources := make(map[string]MediaSource, len(timeline.Initial.Media))
	for _, source := range timeline.Initial.Media {
		sources[source.SourceID] = source
	}
	sharedContent := timeline.Initial.SharedContent
	previousAt := int64(-1)
	for index, event := range timeline.Events {
		base, kind, eventReferences, source, content, err := validateEvent(event, timeline.RecordingID, timeline.Clock.DurationMillis)
		if err != nil {
			return fmt.Errorf("%w: event %d: %v", ErrInvalidTimeline, index, err)
		}
		if base.Sequence != index+1 || base.AtMillis < previousAt {
			return invalid("events must have contiguous sequence and nondecreasing time")
		}
		previousAt = base.AtMillis
		references = append(references, eventReferences...)
		if kind == "media_source_changed" {
			sources[source.SourceID] = source
		}
		if kind == "shared_content_changed" {
			sharedContent = content
		}
		if err := validateVisibleSources(sources, sharedContent); err != nil {
			return err
		}
	}
	for _, reference := range references {
		if _, exists := assetIDs[reference]; !exists {
			return invalid("presentation references a missing asset")
		}
	}
	return nil
}

func (clock Clock) validate() error {
	if clock.Origin != "capture_ready" || clock.Timebase != "recording_relative_ms" ||
		!positiveSafe(clock.CaptureEpoch) || !nonnegativeSafe(clock.DurationMillis) ||
		!boundedString(clock.OriginAuthorityID, 512) {
		return invalid("invalid presentation clock")
	}
	return nil
}

func (cursors SourceCursors) validate() error {
	pairs := [][2]int64{
		{cursors.EpisodeControlStartRevision, cursors.EpisodeControlEndRevision},
		{cursors.ChatStartSequence, cursors.ChatEndSequence},
		{cursors.WhiteboardStartRevision, cursors.WhiteboardEndRevision},
		{cursors.CapturePlanStartRevision, cursors.CapturePlanEndRevision},
	}
	for _, pair := range pairs {
		if !nonnegativeSafe(pair[0]) || !nonnegativeSafe(pair[1]) || pair[1] < pair[0] {
			return invalid("invalid presentation source cursors")
		}
	}
	return nil
}

func (snapshot Snapshot) validate(recordingID string) error {
	if !nonnegativeSafe(snapshot.ElapsedMillis) || snapshot.Participants == nil ||
		len(snapshot.Participants) > MaximumParticipants || snapshot.Media == nil ||
		len(snapshot.Media) > MaximumMediaSources || snapshot.Reactions == nil ||
		len(snapshot.Reactions) > MaximumReactions {
		return invalid("snapshot collections exceed bounds")
	}
	if err := snapshot.Profile.validate(); err != nil {
		return err
	}
	if !boundedString(snapshot.Space.ID, 512) || !boundedString(snapshot.Space.Name, 256) ||
		(snapshot.Space.LogoAssetID != "" && !boundedString(snapshot.Space.LogoAssetID, 512)) ||
		(snapshot.View.Layout != "grid" && snapshot.View.Layout != "presentation") || snapshot.View.Sidebar != "chat" {
		return invalid("invalid Space presentation shell")
	}

	participantIDs := make(map[string]struct{}, len(snapshot.Participants))
	activeSpeakers := 0
	for _, participant := range snapshot.Participants {
		if err := participant.validate(); err != nil {
			return err
		}
		if _, exists := participantIDs[participant.ID]; exists {
			return invalid("duplicate participant identity")
		}
		participantIDs[participant.ID] = struct{}{}
		if participant.ActiveSpeaker {
			activeSpeakers++
		}
	}
	if activeSpeakers > 1 {
		return invalid("multiple active speakers")
	}

	sources := make(map[string]MediaSource, len(snapshot.Media))
	for _, source := range snapshot.Media {
		if err := source.validate(recordingID); err != nil {
			return err
		}
		if _, exists := sources[source.SourceID]; exists {
			return invalid("duplicate media source identity")
		}
		sources[source.SourceID] = source
	}
	if err := snapshot.Chat.validate(); err != nil {
		return err
	}
	if err := snapshot.SharedContent.validate(); err != nil {
		return err
	}
	for _, reaction := range snapshot.Reactions {
		if err := reaction.validate(); err != nil {
			return err
		}
	}
	return validateVisibleSources(sources, snapshot.SharedContent)
}

func (profile Profile) validate() error {
	if !boundedString(profile.Name, 128) || !boundedString(profile.Version, 128) ||
		!sha256Pattern.MatchString(profile.UIBuildSHA256) || !boundedString(profile.Locale, 64) ||
		!boundedString(profile.TimeZone, 128) || profile.FontAssetIDs == nil || len(profile.FontAssetIDs) > 32 ||
		profile.Viewport.Width < 320 || profile.Viewport.Height < 240 ||
		math.IsNaN(profile.Viewport.DeviceScaleFactor) || math.IsInf(profile.Viewport.DeviceScaleFactor, 0) ||
		profile.Viewport.DeviceScaleFactor < 1 || profile.Viewport.DeviceScaleFactor > 4 {
		return invalid("invalid recording presentation profile")
	}
	fontIDs := make(map[string]struct{}, len(profile.FontAssetIDs))
	for _, assetID := range profile.FontAssetIDs {
		if !boundedString(assetID, 512) {
			return invalid("invalid font asset identity")
		}
		if _, exists := fontIDs[assetID]; exists {
			return invalid("duplicate font asset identity")
		}
		fontIDs[assetID] = struct{}{}
	}
	if (profile.Theme.ColorScheme != "light" && profile.Theme.ColorScheme != "dark") ||
		(profile.Theme.Skin != "classic" && profile.Theme.Skin != "chalk") ||
		(profile.Theme.Texture != "none" && profile.Theme.Texture != "paper" && profile.Theme.Texture != "slate") {
		return invalid("invalid presentation theme")
	}
	if _, exists := themePalettes[profile.Theme.Palette]; !exists {
		return invalid("invalid presentation palette")
	}
	return nil
}

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

func (snapshot Snapshot) assetReferences() []string {
	references := append([]string(nil), snapshot.Profile.FontAssetIDs...)
	if snapshot.Space.LogoAssetID != "" {
		references = append(references, snapshot.Space.LogoAssetID)
	}
	for _, participant := range snapshot.Participants {
		if participant.AvatarAssetID != "" {
			references = append(references, participant.AvatarAssetID)
		}
	}
	for _, message := range snapshot.Chat.Messages {
		for _, attachment := range message.Attachments {
			references = append(references, attachment.AssetID)
		}
	}
	if snapshot.SharedContent.Kind == "whiteboard" {
		references = append(references, snapshot.SharedContent.StateAssetID)
	}
	return references
}

func requireID(value string) error {
	if !boundedString(value, 512) {
		return invalid("missing participant identity")
	}
	return nil
}

func boundedString(value string, maximum int) bool { return len(value) > 0 && len(value) <= maximum }
func nonnegativeSafe(value int64) bool             { return value >= 0 && value <= maximumSafeInteger }
func positiveSafe(value int64) bool                { return value > 0 && value <= maximumSafeInteger }
func invalid(message string) error                 { return fmt.Errorf("%w: %s", ErrInvalidTimeline, message) }
