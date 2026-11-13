package captureplan

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

// CanonicalJSON returns a copy of the exact bytes used for the fingerprint.
func (p Plan) CanonicalJSON() []byte { return append([]byte(nil), p.canonicalJSON...) }

func (p Plan) Fingerprint() [sha256.Size]byte { return p.fingerprint }

func (p Plan) FingerprintBytes() []byte {
	return append([]byte(nil), p.fingerprint[:]...)
}

func (p Plan) FingerprintHex() string { return hex.EncodeToString(p.fingerprint[:]) }

// MarshalJSON exposes the canonical representation and prevents callers from
// accidentally serializing the private implementation fields.
func (p Plan) MarshalJSON() ([]byte, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	return p.CanonicalJSON(), nil
}

type canonicalPlan struct {
	SchemaVersion     string                 `json:"schema_version"`
	Authority         canonicalAuthority     `json:"authority"`
	Revision          uint64                 `json:"revision"`
	Cursors           PlanCursors            `json:"cursors"`
	LayoutProfile     LayoutProfile          `json:"layout_profile"`
	ParticipantLimit  int                    `json:"participant_limit"`
	InputBitrateBPS   int64                  `json:"input_bitrate_bps"`
	EffectiveDeadline string                 `json:"effective_deadline"`
	StopState         StopState              `json:"stop_state"`
	StopRequestedAt   string                 `json:"stop_requested_at,omitempty"`
	Participants      []canonicalParticipant `json:"participants"`
	Tracks            []canonicalTrack       `json:"tracks"`
}

type canonicalAuthority struct {
	PlanHandle        PlanHandle `json:"plan_handle"`
	TenantID          string     `json:"tenant_id"`
	SpaceID           string     `json:"space_id"`
	EpisodeID         string     `json:"episode_id"`
	RecordingID       string     `json:"recording_id"`
	JobID             string     `json:"job_id"`
	AttemptCount      int        `json:"attempt_count"`
	FencingGeneration int64      `json:"fencing_generation"`
	CaptureEpoch      uint64     `json:"capture_epoch"`
	EnvelopeDigest    string     `json:"envelope_digest"`
}

type canonicalParticipant struct {
	ID          string               `json:"id"`
	Generation  int64                `json:"generation"`
	DisplayName string               `json:"display_name"`
	JoinOrdinal int64                `json:"join_ordinal"`
	Lifecycle   ParticipantLifecycle `json:"lifecycle"`
}

type canonicalTrack struct {
	ParticipantID         string                         `json:"participant_id"`
	ParticipantGeneration int64                          `json:"participant_generation"`
	Source                captureplane.TrackSource       `json:"source"`
	Kind                  captureplane.TrackKind         `json:"kind"`
	OwnerReference        captureplane.ProviderReference `json:"owner_reference"`
	TrackReference        captureplane.ProviderReference `json:"track_reference"`
	OwnerMID              captureplane.ProviderReference `json:"owner_mid"`
	PublicationReference  PublicationReference           `json:"publication_reference"`
	RequestedLayer        captureplane.TrackLayer        `json:"requested_layer"`
}

func (p Plan) marshalCanonical() ([]byte, error) {
	participants := make([]canonicalParticipant, len(p.participants))
	for i, participant := range p.participants {
		participants[i] = canonicalParticipant{
			ID: participant.ID.String(), Generation: participant.Generation,
			DisplayName: participant.DisplayName, JoinOrdinal: participant.JoinOrdinal,
			Lifecycle: participant.Lifecycle,
		}
	}
	tracks := make([]canonicalTrack, len(p.tracks))
	for i, track := range p.tracks {
		tracks[i] = canonicalTrack{
			ParticipantID: track.ParticipantID.String(), ParticipantGeneration: track.ParticipantGeneration,
			Source: track.Source, Kind: track.Kind, OwnerReference: track.OwnerReference,
			TrackReference: track.TrackReference, OwnerMID: track.OwnerMID,
			PublicationReference: track.PublicationReference, RequestedLayer: track.RequestedLayer,
		}
	}
	authority := canonicalAuthority{
		PlanHandle: p.authority.PlanHandle,
		TenantID:   p.authority.TenantID.String(), SpaceID: p.authority.SpaceID.String(),
		EpisodeID: p.authority.EpisodeID.String(), RecordingID: p.authority.RecordingID.String(),
		JobID: p.authority.JobID.String(), AttemptCount: p.authority.AttemptCount,
		FencingGeneration: p.authority.FencingGeneration,
		CaptureEpoch:      uint64(p.authority.CaptureEpoch),
		EnvelopeDigest:    hex.EncodeToString(p.authority.EnvelopeDigest),
	}
	value := canonicalPlan{
		SchemaVersion: SchemaVersion, Authority: authority, Revision: uint64(p.revision),
		Cursors: p.cursors, LayoutProfile: p.layoutProfile,
		ParticipantLimit: p.participantLimit, InputBitrateBPS: p.inputBitrateBPS,
		EffectiveDeadline: p.effectiveDeadline.UTC().Format(time.RFC3339Nano),
		StopState:         p.stopState, Participants: participants, Tracks: tracks,
	}
	if !p.stopRequestedAt.IsZero() {
		value.StopRequestedAt = p.stopRequestedAt.UTC().Format(time.RFC3339Nano)
	}
	return json.Marshal(value)
}

func cloneAuthority(authority PlanAuthority) PlanAuthority {
	authority.EnvelopeDigest = append([]byte(nil), authority.EnvelopeDigest...)
	return authority
}

func sortParticipants(participants []ParticipantSnapshot) {
	sort.Slice(participants, func(i, j int) bool {
		if participants[i].JoinOrdinal != participants[j].JoinOrdinal {
			return participants[i].JoinOrdinal < participants[j].JoinOrdinal
		}
		return participants[i].ID.String() < participants[j].ID.String()
	})
}

func sortTracks(tracks []TrackSnapshot) {
	sort.Slice(tracks, func(i, j int) bool {
		a, b := tracks[i], tracks[j]
		if a.ParticipantID != b.ParticipantID {
			return a.ParticipantID.String() < b.ParticipantID.String()
		}
		if a.ParticipantGeneration != b.ParticipantGeneration {
			return a.ParticipantGeneration < b.ParticipantGeneration
		}
		if a.Source != b.Source {
			return a.Source < b.Source
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		if a.PublicationReference != b.PublicationReference {
			return a.PublicationReference < b.PublicationReference
		}
		if a.OwnerReference != b.OwnerReference {
			return a.OwnerReference < b.OwnerReference
		}
		if a.TrackReference != b.TrackReference {
			return a.TrackReference < b.TrackReference
		}
		return a.OwnerMID < b.OwnerMID
	})
}
