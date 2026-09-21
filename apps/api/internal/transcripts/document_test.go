package transcripts

import (
	"errors"
	"strings"
	"testing"
)

func TestReadDocumentReturnsReaderFieldsFromTranscriptV1(t *testing.T) {
	document, err := ReadDocument(strings.NewReader(validDocumentJSON), MaxDocumentBytes)
	if err != nil {
		t.Fatalf("ReadDocument() error = %v", err)
	}
	if document.SchemaVersion != "transcript.v1" || len(document.Cues) != 1 {
		t.Fatalf("document = %#v", document)
	}
	cue := document.Cues[0]
	if cue.StartMS != 120 || cue.EndMS != 480 || cue.Text != "Cobalt marker" || !cue.Overlap || cue.Identity == nil {
		t.Fatalf("cue = %#v", cue)
	}
	if cue.Identity.ParticipantRef != "participant-1" || cue.Identity.ParticipantGeneration != 2 || cue.Identity.TrackID != "track-1" || cue.Identity.TrackEpoch != "epoch-1" || cue.Identity.DisplayName == nil || *cue.Identity.DisplayName != "Speaker One" {
		t.Fatalf("cue identity = %#v", cue.Identity)
	}
}

func TestReadDocumentRejectsInvalidOrOversizedPersistedDocuments(t *testing.T) {
	for _, test := range []struct {
		name    string
		body    string
		maximum int64
		want    error
	}{
		{name: "unknown schema", body: strings.Replace(validDocumentJSON, `"transcript.v1"`, `"transcript.v2"`, 1), maximum: MaxDocumentBytes, want: ErrInvalidDocument},
		{name: "missing identity", body: strings.Replace(validDocumentJSON, `"identity":{"kind":"participant","participantRef":"participant-1","participantGeneration":2,"trackId":"track-1","trackEpoch":"epoch-1"},`, "", 1), maximum: MaxDocumentBytes, want: ErrInvalidDocument},
		{name: "invalid cue timing", body: strings.Replace(validDocumentJSON, `"endMs":480`, `"endMs":120`, 1), maximum: MaxDocumentBytes, want: ErrInvalidDocument},
		{name: "unexpected field", body: strings.Replace(validDocumentJSON, `"schemaVersion":"transcript.v1",`, `"schemaVersion":"transcript.v1","speaker":"invented",`, 1), maximum: MaxDocumentBytes, want: ErrInvalidDocument},
		{name: "exceeds bound", body: validDocumentJSON, maximum: 1, want: ErrDocumentTooLarge},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := ReadDocument(strings.NewReader(test.body), test.maximum)
			if !errors.Is(err, test.want) {
				t.Fatalf("ReadDocument() error = %v, want %v", err, test.want)
			}
		})
	}
}

const validDocumentJSON = `{
  "schemaVersion":"transcript.v1",
  "jobId":"job-1",
  "episodeId":"episode-1",
  "cues":[{
    "startMs":120,
    "endMs":480,
    "identity":{"kind":"participant","participantRef":"participant-1","participantGeneration":2,"trackId":"track-1","trackEpoch":"epoch-1"},
    "trackClass":"microphone",
    "displayNameSnapshot":"Speaker One",
    "text":"Cobalt marker",
    "overlap":true,
    "provider":"deepinfra",
    "model":"openai/whisper-large-v3-turbo",
    "versionContract":"deepinfra-native-whisper-turbo.v1",
    "attempt":1,
    "quality":{"confidence":0.91}
  }],
  "language":"en",
  "provider":"deepinfra",
  "model":"openai/whisper-large-v3-turbo",
  "versionContract":"deepinfra-native-whisper-turbo.v1",
  "providerIdentity":{"requestId":"request-1","model":"openai/whisper-large-v3-turbo"},
  "executionIdentity":"execution-1",
  "attempt":1,
  "measuredAudioMs":360,
  "providerObservedDurationMs":360,
  "billedAudioSeconds":0.36,
  "providerReportedCostUsd":0.0000012,
  "quality":{"meanConfidence":0.91,"segmentCount":1,"wordCount":2}
}`
