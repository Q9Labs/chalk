package transcripts

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

const MaxDocumentBytes int64 = 25 * 1024 * 1024

var (
	ErrDocumentTooLarge = errors.New("transcript document exceeds maximum size")
	ErrInvalidDocument  = errors.New("invalid transcript document")
)

type Document struct {
	SchemaVersion string        `json:"schema_version"`
	Cues          []DocumentCue `json:"cues"`
}

type DocumentCue struct {
	StartMS  int64                `json:"start_ms"`
	EndMS    int64                `json:"end_ms"`
	Text     string               `json:"text"`
	Overlap  bool                 `json:"overlap"`
	Identity *DocumentCueIdentity `json:"identity,omitempty"`
}

type DocumentCueIdentity struct {
	ParticipantRef        string  `json:"participant_ref"`
	ParticipantGeneration int64   `json:"participant_generation"`
	TrackID               string  `json:"track_id"`
	TrackEpoch            string  `json:"track_epoch"`
	DisplayName           *string `json:"display_name,omitempty"`
}

// ReadDocument accepts the persisted transcript.v1 artifact emitted by the
// dispatcher and exposes only fields intended for transcript readers.
func ReadDocument(reader io.Reader, maximumBytes int64) (Document, error) {
	if maximumBytes <= 0 {
		return Document{}, ErrDocumentTooLarge
	}

	encoded, err := io.ReadAll(io.LimitReader(reader, maximumBytes+1))
	if err != nil {
		return Document{}, err
	}
	if int64(len(encoded)) > maximumBytes {
		return Document{}, ErrDocumentTooLarge
	}

	var persisted persistedDocument
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&persisted); err != nil {
		return Document{}, ErrInvalidDocument
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Document{}, ErrInvalidDocument
	}
	if err := persisted.validate(); err != nil {
		return Document{}, ErrInvalidDocument
	}

	result := Document{SchemaVersion: persisted.SchemaVersion, Cues: make([]DocumentCue, 0, len(persisted.Cues))}
	for _, cue := range persisted.Cues {
		result.Cues = append(result.Cues, DocumentCue{
			StartMS: cue.StartMS,
			EndMS:   cue.EndMS,
			Text:    cue.Text,
			Overlap: *cue.Overlap,
			Identity: &DocumentCueIdentity{
				ParticipantRef:        cue.Identity.ParticipantRef,
				ParticipantGeneration: *cue.Identity.ParticipantGeneration,
				TrackID:               cue.Identity.TrackID,
				TrackEpoch:            cue.Identity.TrackEpoch,
				DisplayName:           cue.DisplayNameSnapshot,
			},
		})
	}
	return result, nil
}

type persistedDocument struct {
	SchemaVersion              string                     `json:"schemaVersion"`
	JobID                      string                     `json:"jobId"`
	EpisodeID                  string                     `json:"episodeId"`
	Cues                       []persistedCue             `json:"cues"`
	Language                   *string                    `json:"language,omitempty"`
	Provider                   string                     `json:"provider"`
	Model                      string                     `json:"model"`
	VersionContract            string                     `json:"versionContract"`
	ProviderIdentity           *persistedProviderIdentity `json:"providerIdentity,omitempty"`
	ExecutionIdentity          *string                    `json:"executionIdentity,omitempty"`
	Attempt                    *int64                     `json:"attempt"`
	MeasuredAudioMS            *int64                     `json:"measuredAudioMs"`
	ProviderObservedDurationMS *int64                     `json:"providerObservedDurationMs,omitempty"`
	BilledAudioSeconds         *float64                   `json:"billedAudioSeconds,omitempty"`
	ProviderReportedCostUSD    *float64                   `json:"providerReportedCostUsd,omitempty"`
	Quality                    *persistedQuality          `json:"quality,omitempty"`
}

type persistedCue struct {
	StartMS             int64                `json:"startMs"`
	EndMS               int64                `json:"endMs"`
	Identity            *persistedIdentity   `json:"identity"`
	TrackClass          string               `json:"trackClass"`
	DisplayNameSnapshot *string              `json:"displayNameSnapshot,omitempty"`
	Text                string               `json:"text"`
	Overlap             *bool                `json:"overlap"`
	Provider            string               `json:"provider"`
	Model               string               `json:"model"`
	VersionContract     string               `json:"versionContract"`
	Attempt             *int64               `json:"attempt"`
	Quality             *persistedCueQuality `json:"quality,omitempty"`
}

type persistedIdentity struct {
	Kind                  string `json:"kind"`
	ParticipantRef        string `json:"participantRef"`
	ParticipantGeneration *int64 `json:"participantGeneration"`
	TrackID               string `json:"trackId"`
	TrackEpoch            string `json:"trackEpoch"`
}

type persistedProviderIdentity struct {
	RequestID    *string `json:"requestId,omitempty"`
	Model        *string `json:"model,omitempty"`
	ModelVersion *string `json:"modelVersion,omitempty"`
}

type persistedQuality struct {
	MeanConfidence *float64 `json:"meanConfidence,omitempty"`
	SegmentCount   *int64   `json:"segmentCount"`
	WordCount      *int64   `json:"wordCount"`
}

type persistedCueQuality struct {
	Confidence *float64 `json:"confidence,omitempty"`
}

func (document persistedDocument) validate() error {
	if document.SchemaVersion != "transcript.v1" || document.JobID == "" || document.EpisodeID == "" || document.Cues == nil || !validDocumentProvider(document.Provider) || document.Model == "" || document.VersionContract == "" || document.Attempt == nil || *document.Attempt < 0 || document.MeasuredAudioMS == nil || *document.MeasuredAudioMS < 0 {
		return ErrInvalidDocument
	}
	if document.Language != nil && *document.Language == "" {
		return ErrInvalidDocument
	}
	if document.ProviderObservedDurationMS != nil && *document.ProviderObservedDurationMS < 0 {
		return ErrInvalidDocument
	}
	if !validNonNegativeFloat(document.BilledAudioSeconds) || !validNonNegativeFloat(document.ProviderReportedCostUSD) || !validQuality(document.Quality) {
		return ErrInvalidDocument
	}
	for _, cue := range document.Cues {
		if err := cue.validate(); err != nil {
			return err
		}
	}
	return nil
}

func (cue persistedCue) validate() error {
	if cue.StartMS < 0 || cue.EndMS <= cue.StartMS || cue.Identity == nil || cue.TrackClass != "microphone" || cue.Text == "" || cue.Overlap == nil || !validCueProvider(cue.Provider) || cue.Model == "" || cue.VersionContract == "" || cue.Attempt == nil || *cue.Attempt < 0 || !validCueQuality(cue.Quality) {
		return ErrInvalidDocument
	}
	if cue.DisplayNameSnapshot != nil && *cue.DisplayNameSnapshot == "" {
		return ErrInvalidDocument
	}
	return cue.Identity.validate()
}

func (identity persistedIdentity) validate() error {
	if identity.Kind != "participant" || identity.ParticipantRef == "" || identity.ParticipantGeneration == nil || *identity.ParticipantGeneration < 1 || identity.TrackID == "" || identity.TrackEpoch == "" {
		return ErrInvalidDocument
	}
	return nil
}

func validDocumentProvider(provider string) bool {
	return provider == "deepinfra" || provider == "cloudflare" || provider == "mixed"
}

func validCueProvider(provider string) bool {
	return provider == "deepinfra" || provider == "cloudflare"
}

func validNonNegativeFloat(value *float64) bool {
	return value == nil || (*value >= 0 && *value < 1.7976931348623157e+308)
}

func validQuality(quality *persistedQuality) bool {
	return quality == nil || (quality.SegmentCount != nil && *quality.SegmentCount >= 0 && quality.WordCount != nil && *quality.WordCount >= 0 && validConfidence(quality.MeanConfidence))
}

func validCueQuality(quality *persistedCueQuality) bool {
	return quality == nil || validConfidence(quality.Confidence)
}

func validConfidence(value *float64) bool {
	return value == nil || (*value >= 0 && *value <= 1)
}
