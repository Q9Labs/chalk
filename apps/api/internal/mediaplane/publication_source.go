package mediaplane

import "strings"

// PublicationSource is the kind of track a participant publishes. A screen share
// publishes two sources, the video ("screen") and its audio ("screen_audio").
type PublicationSource string

const (
	SourceMicrophone  PublicationSource = "microphone"
	SourceCamera      PublicationSource = "camera"
	SourceScreen      PublicationSource = "screen"
	SourceScreenAudio PublicationSource = "screen_audio"
)

// Valid reports whether the source is one of the four sources.
func (source PublicationSource) Valid() bool {
	switch source {
	case SourceMicrophone, SourceCamera, SourceScreen, SourceScreenAudio:
		return true
	default:
		return false
	}
}

// IsAudio reports whether the source carries audio.
func (source PublicationSource) IsAudio() bool {
	return source == SourceMicrophone || source == SourceScreenAudio
}

// Selectable reports whether a participant picks the source on its own. Screen
// audio follows the screen share and is never chosen alone.
func (source PublicationSource) Selectable() bool {
	return source.Valid() && source != SourceScreenAudio
}

// SelectableSources are the sources a participant picks on its own.
var SelectableSources = []PublicationSource{SourceMicrophone, SourceCamera, SourceScreen}

// Companion is the source published together with this one and controlled with it:
// the audio of a shared tab follows the screen.
func (source PublicationSource) Companion() (PublicationSource, bool) {
	if source == SourceScreen {
		return SourceScreenAudio, true
	}
	return "", false
}

// IsCompanionOf reports whether source is the companion of primary.
func (source PublicationSource) IsCompanionOf(primary PublicationSource) bool {
	companion, ok := primary.Companion()
	return ok && companion == source
}

// Trimmed returns the source without surrounding white space.
func (source PublicationSource) Trimmed() PublicationSource {
	return PublicationSource(strings.TrimSpace(string(source)))
}

// AllSources are the four sources.
var AllSources = []PublicationSource{SourceMicrophone, SourceCamera, SourceScreen, SourceScreenAudio}
