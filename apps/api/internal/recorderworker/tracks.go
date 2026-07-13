package recorderworker

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
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

func ValidateTrackEpochs(tracks []AuthenticatedTrack) error {
	audioEpoch := map[string]int64{}
	seenTrack := map[string]struct{}{}
	for _, track := range tracks {
		if track.ParticipantID == "" || track.TrackID == "" || track.Epoch < 1 || track.EndMs <= track.StartMs || !track.Authorized {
			return errors.New("track must have an authorized owner, epoch, and interval")
		}
		if _, ok := seenTrack[track.TrackID]; ok {
			return fmt.Errorf("track ID %s is duplicated", track.TrackID)
		}
		seenTrack[track.TrackID] = struct{}{}
		if track.Class == TrackAudio {
			if prior, ok := audioEpoch[track.ParticipantID]; ok && track.Epoch <= prior {
				return fmt.Errorf("track epoch for participant %s is not increasing", track.ParticipantID)
			}
			audioEpoch[track.ParticipantID] = track.Epoch
		}
	}
	return nil
}

type SpeechInterval struct {
	ParticipantID string `json:"participant_id"`
	TrackID       string `json:"track_id"`
	Epoch         int64  `json:"epoch"`
	StartMs       int64  `json:"start_ms"`
	EndMs         int64  `json:"end_ms"`
	SourceHash    string `json:"source_hash"`
}

func (i SpeechInterval) valid() bool {
	return i.ParticipantID != "" && i.TrackID != "" && i.Epoch > 0 && i.EndMs > i.StartMs
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

// BuildSpeakerTurnManifest emits a non-overlapping interval once and emits one
// turn per participant for every actual overlap. Track identity is authenticated
// before intervals are accepted; no acoustic identity inference occurs.
func BuildSpeakerTurnManifest(tracks []AuthenticatedTrack, intervals []SpeechInterval, policyVersion string) (SpeakerTurnManifest, error) {
	if policyVersion == "" {
		return SpeakerTurnManifest{}, errors.New("speech policy version is required")
	}
	if err := ValidateTrackEpochs(tracks); err != nil {
		return SpeakerTurnManifest{}, err
	}
	known := make(map[string]AuthenticatedTrack, len(tracks))
	for _, track := range tracks {
		known[track.TrackID] = track
	}
	valid := make([]SpeechInterval, 0, len(intervals))
	for _, interval := range intervals {
		track, ok := known[interval.TrackID]
		if !ok || !interval.valid() || track.ParticipantID != interval.ParticipantID || track.Epoch != interval.Epoch || interval.StartMs < track.StartMs || interval.EndMs > track.EndMs {
			return SpeakerTurnManifest{}, fmt.Errorf("interval is not authenticated by its track epoch: %s", interval.TrackID)
		}
		if interval.SourceHash == "" {
			return SpeakerTurnManifest{}, errors.New("speech interval source checksum is required")
		}
		valid = append(valid, interval)
	}
	sort.Slice(valid, func(i, j int) bool {
		if valid[i].StartMs != valid[j].StartMs {
			return valid[i].StartMs < valid[j].StartMs
		}
		if valid[i].EndMs != valid[j].EndMs {
			return valid[i].EndMs < valid[j].EndMs
		}
		if valid[i].ParticipantID != valid[j].ParticipantID {
			return valid[i].ParticipantID < valid[j].ParticipantID
		}
		return valid[i].TrackID < valid[j].TrackID
	})
	boundaries := make([]int64, 0, len(valid)*2)
	for _, interval := range valid {
		boundaries = append(boundaries, interval.StartMs, interval.EndMs)
	}
	sort.Slice(boundaries, func(i, j int) bool { return boundaries[i] < boundaries[j] })
	unique := boundaries[:0]
	for _, boundary := range boundaries {
		if len(unique) == 0 || unique[len(unique)-1] != boundary {
			unique = append(unique, boundary)
		}
	}
	turns := make([]SpeakerTurn, 0, len(valid))
	for i := 0; i+1 < len(unique); i++ {
		start, end := unique[i], unique[i+1]
		if end <= start {
			continue
		}
		active := make(map[string]SpeechInterval)
		for _, interval := range valid {
			if interval.StartMs <= start && interval.EndMs >= end {
				prior, exists := active[interval.ParticipantID]
				if !exists || interval.TrackID < prior.TrackID {
					active[interval.ParticipantID] = interval
				}
			}
		}
		if len(active) == 0 {
			continue
		}
		participants := make([]string, 0, len(active))
		for participant := range active {
			participants = append(participants, participant)
		}
		sort.Strings(participants)
		overlap := len(participants) > 1
		for _, participant := range participants {
			interval := active[participant]
			turns = append(turns, SpeakerTurn{ParticipantID: interval.ParticipantID, TrackID: interval.TrackID, Epoch: interval.Epoch, StartMs: start, EndMs: end, Overlap: overlap, SourceHashes: []string{interval.SourceHash}})
		}
	}
	return SpeakerTurnManifest{Version: "speaker-turns.v1", Tracks: append([]AuthenticatedTrack(nil), tracks...), Turns: turns, Policy: policyVersion}, nil
}

type AudioChunkPlan struct {
	Sequence       int      `json:"sequence"`
	StartMs        int64    `json:"start_ms"`
	EndMs          int64    `json:"end_ms"`
	LocalStartMs   int64    `json:"local_start_ms"`
	LocalEndMs     int64    `json:"local_end_ms"`
	MeetingStartMs int64    `json:"meeting_start_ms"`
	MeetingEndMs   int64    `json:"meeting_end_ms"`
	ContextMs      int64    `json:"context_ms"`
	PolicyVersion  string   `json:"policy_version"`
	SourceHashes   []string `json:"source_hashes"`
	Codec          string   `json:"codec"`
	SampleRate     int      `json:"sample_rate"`
	Channels       int      `json:"channels"`
}

func BuildAudioChunkPlan(manifest SpeakerTurnManifest, maxDurationMs, contextMs int64) ([]AudioChunkPlan, error) {
	if maxDurationMs <= 0 || contextMs < 0 {
		return nil, errors.New("audio chunk duration must be positive and context non-negative")
	}
	chunks := make([]AudioChunkPlan, 0, len(manifest.Turns))
	sequence := 0
	for _, turn := range manifest.Turns {
		start := turn.StartMs - contextMs
		if start < 0 {
			start = 0
		}
		end := turn.EndMs + contextMs
		local := int64(0)
		for start < end {
			chunkEnd := start + maxDurationMs
			if chunkEnd > end {
				chunkEnd = end
			}
			chunks = append(chunks, AudioChunkPlan{Sequence: sequence, StartMs: start, EndMs: chunkEnd, LocalStartMs: local, LocalEndMs: local + chunkEnd - start, MeetingStartMs: start, MeetingEndMs: chunkEnd, ContextMs: contextMs, PolicyVersion: manifest.Policy, SourceHashes: append([]string(nil), turn.SourceHashes...), Codec: "mp3", SampleRate: 16000, Channels: 1})
			sequence++
			local += chunkEnd - start
			start = chunkEnd
		}
	}
	return chunks, nil
}

func Checksum(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
