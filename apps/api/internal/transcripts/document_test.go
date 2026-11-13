package transcripts

import (
	"errors"
	"testing"
)

func ptr[T any](value T) *T { return &value }

func validPersistedDocument() persistedDocument {
	return persistedDocument{
		SchemaVersion: "transcript.v1", JobID: "j", EpisodeID: "e", Cues: []persistedCue{},
		Provider: "deepinfra", Model: "m", VersionContract: "v",
		Attempt: ptr(int64(0)), MeasuredAudioMS: ptr(int64(0)),
	}
}

func TestPersistedDocumentValidate(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*persistedDocument)
		ok     bool
	}{
		{"valid", func(*persistedDocument) {}, true},
		{"auto language", func(d *persistedDocument) { d.TranscriptLanguage = &persistedTranscriptLanguage{Mode: "auto"} }, true},
		{"auto language with code", func(d *persistedDocument) {
			d.TranscriptLanguage = &persistedTranscriptLanguage{Mode: "auto", Language: "en"}
		}, false},
		{"fixed language", func(d *persistedDocument) {
			d.TranscriptLanguage = &persistedTranscriptLanguage{Mode: "fixed", Language: "en"}
		}, true},
		{"fixed auto", func(d *persistedDocument) {
			d.TranscriptLanguage = &persistedTranscriptLanguage{Mode: "fixed", Language: "auto"}
		}, false},
		{"fixed unknown", func(d *persistedDocument) {
			d.TranscriptLanguage = &persistedTranscriptLanguage{Mode: "fixed", Language: "zz"}
		}, false},
		{"unknown mode", func(d *persistedDocument) { d.TranscriptLanguage = &persistedTranscriptLanguage{Mode: "x"} }, false},
		{"schema version", func(d *persistedDocument) { d.SchemaVersion = "v2" }, false},
		{"job id", func(d *persistedDocument) { d.JobID = "" }, false},
		{"episode id", func(d *persistedDocument) { d.EpisodeID = "" }, false},
		{"nil cues", func(d *persistedDocument) { d.Cues = nil }, false},
		{"provider cloudflare", func(d *persistedDocument) { d.Provider = "cloudflare" }, true},
		{"provider openrouter", func(d *persistedDocument) { d.Provider = "openrouter" }, true},
		{"provider mixed", func(d *persistedDocument) { d.Provider = "mixed" }, true},
		{"provider unknown", func(d *persistedDocument) { d.Provider = "x" }, false},
		{"model", func(d *persistedDocument) { d.Model = "" }, false},
		{"version contract", func(d *persistedDocument) { d.VersionContract = "" }, false},
		{"nil attempt", func(d *persistedDocument) { d.Attempt = nil }, false},
		{"negative attempt", func(d *persistedDocument) { d.Attempt = ptr(int64(-1)) }, false},
		{"nil measured", func(d *persistedDocument) { d.MeasuredAudioMS = nil }, false},
		{"negative measured", func(d *persistedDocument) { d.MeasuredAudioMS = ptr(int64(-1)) }, false},
		{"empty language", func(d *persistedDocument) { d.Language = ptr("") }, false},
		{"language", func(d *persistedDocument) { d.Language = ptr("en") }, true},
		{"negative observed", func(d *persistedDocument) { d.ProviderObservedDurationMS = ptr(int64(-1)) }, false},
		{"observed", func(d *persistedDocument) { d.ProviderObservedDurationMS = ptr(int64(0)) }, true},
		{"negative billed", func(d *persistedDocument) { d.BilledAudioSeconds = ptr(-1.0) }, false},
		{"billed", func(d *persistedDocument) { d.BilledAudioSeconds = ptr(1.5) }, true},
		{"negative cost", func(d *persistedDocument) { d.ProviderReportedCostUSD = ptr(-0.1) }, false},
		{"max float cost", func(d *persistedDocument) { d.ProviderReportedCostUSD = ptr(1.7976931348623157e+308) }, false},
		{"quality missing segments", func(d *persistedDocument) {
			d.Quality = &persistedQuality{WordCount: ptr(int64(1))}
		}, false},
		{"quality missing words", func(d *persistedDocument) {
			d.Quality = &persistedQuality{SegmentCount: ptr(int64(1))}
		}, false},
		{"quality negative segments", func(d *persistedDocument) {
			d.Quality = &persistedQuality{SegmentCount: ptr(int64(-1)), WordCount: ptr(int64(1))}
		}, false},
		{"quality negative words", func(d *persistedDocument) {
			d.Quality = &persistedQuality{SegmentCount: ptr(int64(1)), WordCount: ptr(int64(-1))}
		}, false},
		{"quality bad confidence", func(d *persistedDocument) {
			d.Quality = &persistedQuality{SegmentCount: ptr(int64(1)), WordCount: ptr(int64(1)), MeanConfidence: ptr(1.1)}
		}, false},
		{"quality", func(d *persistedDocument) {
			d.Quality = &persistedQuality{SegmentCount: ptr(int64(1)), WordCount: ptr(int64(1)), MeanConfidence: ptr(1.0)}
		}, true},
		{"cue valid", func(d *persistedDocument) { d.Cues = []persistedCue{validPersistedCue()} }, true},
		{"cue invalid", func(d *persistedDocument) {
			cue := validPersistedCue()
			cue.Text = ""
			d.Cues = []persistedCue{validPersistedCue(), cue}
		}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			document := validPersistedDocument()
			tc.mutate(&document)
			err := document.validate()
			if tc.ok && err != nil {
				t.Fatalf("unexpected error %v", err)
			}
			if !tc.ok && !errors.Is(err, ErrInvalidDocument) {
				t.Fatalf("error = %v, want ErrInvalidDocument", err)
			}
		})
	}
}

func validPersistedCue() persistedCue {
	return persistedCue{
		StartMS: 0, EndMS: 1, Text: "hi", Overlap: ptr(false), TrackClass: "microphone",
		Provider: "deepinfra", Model: "m", VersionContract: "v", Attempt: ptr(int64(0)),
		Identity: &persistedIdentity{Kind: "participant", ParticipantRef: "p", ParticipantGeneration: ptr(int64(1)), TrackID: "t", TrackEpoch: "e"},
	}
}

func TestPersistedCueValidate(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*persistedCue)
		ok     bool
	}{
		{"valid", func(*persistedCue) {}, true},
		{"negative start", func(c *persistedCue) { c.StartMS = -1 }, false},
		{"end equals start", func(c *persistedCue) { c.EndMS = 0 }, false},
		{"nil identity", func(c *persistedCue) { c.Identity = nil }, false},
		{"track class", func(c *persistedCue) { c.TrackClass = "screen" }, false},
		{"empty text", func(c *persistedCue) { c.Text = "" }, false},
		{"nil overlap", func(c *persistedCue) { c.Overlap = nil }, false},
		{"mixed provider", func(c *persistedCue) { c.Provider = "mixed" }, false},
		{"cloudflare provider", func(c *persistedCue) { c.Provider = "cloudflare" }, true},
		{"model", func(c *persistedCue) { c.Model = "" }, false},
		{"version", func(c *persistedCue) { c.VersionContract = "" }, false},
		{"nil attempt", func(c *persistedCue) { c.Attempt = nil }, false},
		{"negative attempt", func(c *persistedCue) { c.Attempt = ptr(int64(-1)) }, false},
		{"bad quality", func(c *persistedCue) { c.Quality = &persistedCueQuality{Confidence: ptr(2.0)} }, false},
		{"quality", func(c *persistedCue) { c.Quality = &persistedCueQuality{Confidence: ptr(0.5)} }, true},
		{"empty display name", func(c *persistedCue) { c.DisplayNameSnapshot = ptr("") }, false},
		{"display name", func(c *persistedCue) { c.DisplayNameSnapshot = ptr("N") }, true},
		{"identity kind", func(c *persistedCue) { c.Identity.Kind = "x" }, false},
		{"identity ref", func(c *persistedCue) { c.Identity.ParticipantRef = "" }, false},
		{"identity nil generation", func(c *persistedCue) { c.Identity.ParticipantGeneration = nil }, false},
		{"identity zero generation", func(c *persistedCue) { c.Identity.ParticipantGeneration = ptr(int64(0)) }, false},
		{"identity track", func(c *persistedCue) { c.Identity.TrackID = "" }, false},
		{"identity epoch", func(c *persistedCue) { c.Identity.TrackEpoch = "" }, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cue := validPersistedCue()
			tc.mutate(&cue)
			err := cue.validate()
			if tc.ok && err != nil {
				t.Fatalf("unexpected error %v", err)
			}
			if !tc.ok && !errors.Is(err, ErrInvalidDocument) {
				t.Fatalf("error = %v, want ErrInvalidDocument", err)
			}
		})
	}
}
