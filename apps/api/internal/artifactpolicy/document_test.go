package artifactpolicy

import (
	"errors"
	"testing"
	"time"
)

func validDocument() Document {
	return Document{
		SchemaVersion: SnapshotSchemaVersion,
		Recording:     RecordingDocument{Mode: RecordingManual, Profile: RecordingProfile, RetentionSeconds: 60},
		Transcription: TranscriptionDocument{Mode: TranscriptionOnDemand, ProviderPolicyVersion: "v1", RetentionSeconds: 60, SourceWindowSeconds: 3600},
	}
}

func TestDocumentValidateReportsTheFirstBrokenRule(t *testing.T) {
	cases := map[string]struct {
		change func(*Document)
		want   error
	}{
		"valid":                   {func(*Document) {}, nil},
		"disabled transcription":  {func(d *Document) { d.Transcription = TranscriptionDocument{Mode: TranscriptionDisabled} }, nil},
		"schema":                  {func(d *Document) { d.SchemaVersion = "old" }, ErrInvalidSnapshotSchema},
		"profile":                 {func(d *Document) { d.Recording.Profile = "other" }, ErrInvalidRecordingProfile},
		"negative recording keep": {func(d *Document) { d.Recording.RetentionSeconds = -1 }, ErrInvalidRetention},
		"huge transcription keep": {func(d *Document) { d.Transcription.RetentionSeconds = MaximumRetentionSeconds + 1 }, ErrInvalidRetention},
		"negative window":         {func(d *Document) { d.Transcription.SourceWindowSeconds = -1 }, ErrInvalidSourceWindow},
		"huge window":             {func(d *Document) { d.Transcription.SourceWindowSeconds = int64(MaximumSourceWindow/time.Second) + 1 }, ErrInvalidSourceWindow},
		"disabled with window": {func(d *Document) {
			d.Transcription = TranscriptionDocument{Mode: TranscriptionDisabled, SourceWindowSeconds: 5}
		}, ErrInvalidSourceWindow},
		"enabled without window":   {func(d *Document) { d.Transcription.SourceWindowSeconds = 0 }, ErrInvalidSourceWindow},
		"enabled without provider": {func(d *Document) { d.Transcription.ProviderPolicyVersion = "" }, ErrMissingProviderPolicy},
	}
	for name, test := range cases {
		document := validDocument()
		test.change(&document)
		if err := document.Validate(); !errors.Is(err, test.want) {
			t.Errorf("%s: error = %v, want %v", name, err, test.want)
		}
	}
	badRecording := validDocument()
	badRecording.Recording.Mode = "nope"
	badTranscription := validDocument()
	badTranscription.Transcription.Mode = "nope"
	if badRecording.Validate() == nil || badTranscription.Validate() == nil {
		t.Error("an unknown mode must fail")
	}
}
