package transcripts

import (
	"strings"
	"testing"
)

func TestFormatTextSaysWhenTheTranscriptNeverHadAnAudioSource(t *testing.T) {
	missing := FormatText(Document{}, TextMetadata{SpaceTitle: "Room", SourceMissing: true})
	if strings.Contains(missing, "No speech was transcribed") || !strings.Contains(missing, "No audio source was available") {
		t.Fatalf("a missing source must not read as silence:\n%s", missing)
	}
	silent := FormatText(Document{}, TextMetadata{SpaceTitle: "Room"})
	if !strings.Contains(silent, "No speech was transcribed.") {
		t.Fatalf("a transcript of an existing source with no cues reads as silence:\n%s", silent)
	}
}
