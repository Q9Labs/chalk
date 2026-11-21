package recorderworker

import (
	"crypto/sha256"
	"encoding/hex"
)

type TrackClass string

const (
	TrackAudio     TrackClass = "audio"
	TrackScreen    TrackClass = "screen"
	TrackVideo     TrackClass = "video"
	TrackThumbnail TrackClass = "thumbnail"
)

type AuthenticatedTrack struct {
	ParticipantID string     `json:"participant_id"`
	TrackID       string     `json:"track_id"`
	Epoch         int64      `json:"epoch"`
	Class         TrackClass `json:"class"`
	StartMs       int64      `json:"start_ms"`
	EndMs         int64      `json:"end_ms"`
	Authorized    bool       `json:"authorized"`
	SourceHash    string     `json:"source_hash,omitempty"`
}

type SpeechInterval struct {
	ParticipantID string `json:"participant_id"`
	TrackID       string `json:"track_id"`
	Epoch         int64  `json:"epoch"`
	StartMs       int64  `json:"start_ms"`
	EndMs         int64  `json:"end_ms"`
	SourceHash    string `json:"source_hash"`
}

type SpeakerTurn struct {
	ParticipantID string   `json:"participant_id"`
	TrackID       string   `json:"track_id"`
	Epoch         int64    `json:"epoch"`
	StartMs       int64    `json:"start_ms"`
	EndMs         int64    `json:"end_ms"`
	Overlap       bool     `json:"overlap"`
	SourceHashes  []string `json:"source_hashes"`
}

type SpeakerTurnManifest struct {
	Version string               `json:"version"`
	Tracks  []AuthenticatedTrack `json:"tracks"`
	Turns   []SpeakerTurn        `json:"turns"`
	Policy  string               `json:"policy"`
}

type AudioChunkPlan struct {
	Sequence       int      `json:"sequence"`
	StartMs        int64    `json:"start_ms"`
	EndMs          int64    `json:"end_ms"`
	LocalStartMs   int64    `json:"local_start_ms"`
	LocalEndMs     int64    `json:"local_end_ms"`
	EpisodeStartMs int64    `json:"episode_start_ms"`
	EpisodeEndMs   int64    `json:"episode_end_ms"`
	ContextMs      int64    `json:"context_ms"`
	PolicyVersion  string   `json:"policy_version"`
	SourceHashes   []string `json:"source_hashes"`
	Codec          string   `json:"codec"`
	SampleRate     int      `json:"sample_rate"`
	Channels       int      `json:"channels"`
}

func Checksum(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
