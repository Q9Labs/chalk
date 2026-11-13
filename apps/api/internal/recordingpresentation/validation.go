package recordingpresentation

import (
	"fmt"
	"math"
	"regexp"
)

var sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var sourceIDPattern = regexp.MustCompile(`^rps_[0-9a-f]{64}$`)

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
		(profile.UIBuildSHA256 != "" && !sha256Pattern.MatchString(profile.UIBuildSHA256)) || !boundedString(profile.Locale, 64) ||
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
	_, colorSchemeKnown := themeColorSchemes[profile.Theme.ColorScheme]
	_, skinKnown := themeSkins[profile.Theme.Skin]
	_, textureKnown := themeTextures[profile.Theme.Texture]
	if !colorSchemeKnown || !skinKnown || !textureKnown {
		return invalid("invalid presentation theme")
	}
	if _, exists := themePalettes[profile.Theme.Palette]; !exists {
		return invalid("invalid presentation palette")
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
