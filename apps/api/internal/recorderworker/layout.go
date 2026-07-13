package recorderworker

import (
	"errors"
	"sort"
)

const MaxStripParticipants = 6

type LayoutPolicy struct {
	Version       string `json:"version"`
	StripLimit    int    `json:"strip_limit"`
	HysteresisMs  int64  `json:"hysteresis_ms"`
	AudioWindowMs int64  `json:"audio_window_ms"`
}

func (p LayoutPolicy) validate() error {
	if p.Version == "" || p.HysteresisMs < 0 || p.AudioWindowMs <= 0 {
		return errors.New("layout policy version, window, and hysteresis are required")
	}
	if p.StripLimit <= 0 || p.StripLimit > MaxStripParticipants {
		return errors.New("strip limit must be between one and six")
	}
	return nil
}

type LayoutEvent struct {
	AtMs          int64  `json:"at_ms"`
	Kind          string `json:"kind"`
	ParticipantID string `json:"participant_id,omitempty"`
	TrackID       string `json:"track_id,omitempty"`
	StartedAtMs   int64  `json:"started_at_ms,omitempty"`
	AudioLevel    int    `json:"audio_level,omitempty"`
	Muted         bool   `json:"muted,omitempty"`
	Active        bool   `json:"active,omitempty"`
}

type Participant struct {
	ID          string `json:"id"`
	JoinAtMs    int64  `json:"join_at_ms"`
	DisplayName string `json:"display_name"`
}

type LayoutDecision struct {
	AtMs        int64    `json:"at_ms"`
	Policy      string   `json:"policy"`
	PrimaryType string   `json:"primary_type"`
	PrimaryID   string   `json:"primary_id,omitempty"`
	Strip       []string `json:"strip"`
}

type StageTimeline struct {
	Policy    LayoutPolicy     `json:"policy"`
	Events    []LayoutEvent    `json:"events"`
	Decisions []LayoutDecision `json:"decisions"`
}

func BuildStageTimeline(policy LayoutPolicy, participants []Participant, events []LayoutEvent) (StageTimeline, error) {
	if err := policy.validate(); err != nil {
		return StageTimeline{}, err
	}
	ordered := append([]LayoutEvent(nil), events...)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].AtMs != ordered[j].AtMs {
			return ordered[i].AtMs < ordered[j].AtMs
		}
		if ordered[i].Kind != ordered[j].Kind {
			return ordered[i].Kind < ordered[j].Kind
		}
		return ordered[i].ParticipantID < ordered[j].ParticipantID
	})
	selector := ActiveSpeakerSelector{HysteresisMs: policy.HysteresisMs}
	levels := make(map[string]SpeakerLevel)
	decisions := make([]LayoutDecision, 0, len(ordered))
	for index := 0; index < len(ordered); {
		atMs := ordered[index].AtMs
		for index < len(ordered) && ordered[index].AtMs == atMs {
			event := ordered[index]
			if event.Kind == "audio_level" && event.ParticipantID != "" {
				levels[event.ParticipantID] = SpeakerLevel{AtMs: event.AtMs, ParticipantID: event.ParticipantID, Level: event.AudioLevel, Muted: event.Muted}
			}
			index++
		}
		levelSlice := make([]SpeakerLevel, 0, len(levels))
		for participantID, level := range levels {
			if atMs-level.AtMs > policy.AudioWindowMs {
				delete(levels, participantID)
				continue
			}
			levelSlice = append(levelSlice, level)
		}
		active := selector.Observe(levelSlice, atMs)
		decision, err := SelectLayout(atMs, policy, participants, ordered[:index], active)
		if err != nil {
			return StageTimeline{}, err
		}
		decisions = append(decisions, decision)
	}
	return StageTimeline{Policy: policy, Events: ordered, Decisions: decisions}, nil
}

// SelectLayout makes one deterministic decision from events observed at atMs.
// Screens win by earliest start time and opaque ID. Without a screen, the
// selected speaker is supplied by ActiveSpeakerSelector; strip order is stable
// join time followed by participant ID and never includes the primary.
func SelectLayout(atMs int64, policy LayoutPolicy, participants []Participant, events []LayoutEvent, active string) (LayoutDecision, error) {
	if err := policy.validate(); err != nil {
		return LayoutDecision{}, err
	}
	screens := make(map[string]LayoutEvent)
	for _, event := range events {
		if event.AtMs > atMs || event.Kind != "screen_share" || event.ParticipantID == "" {
			continue
		}
		if event.Active {
			current, ok := screens[event.ParticipantID]
			if !ok || event.StartedAtMs < current.StartedAtMs || (event.StartedAtMs == current.StartedAtMs && event.ParticipantID < current.ParticipantID) {
				screens[event.ParticipantID] = event
			}
		} else {
			delete(screens, event.ParticipantID)
		}
	}

	primaryType := "speaker"
	primaryID := active
	if len(screens) > 0 {
		primaryType = "screen"
		primaryID = ""
		for id, screen := range screens {
			if primaryID == "" || screen.StartedAtMs < screens[primaryID].StartedAtMs || (screen.StartedAtMs == screens[primaryID].StartedAtMs && id < primaryID) {
				primaryID = id
			}
		}
	}
	if primaryID == "" {
		primaryType = "none"
	}
	ordered := append([]Participant(nil), participants...)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].JoinAtMs != ordered[j].JoinAtMs {
			return ordered[i].JoinAtMs < ordered[j].JoinAtMs
		}
		return ordered[i].ID < ordered[j].ID
	})
	strip := make([]string, 0, policy.StripLimit)
	for _, participant := range ordered {
		if participant.ID == primaryID || len(strip) == policy.StripLimit {
			continue
		}
		strip = append(strip, participant.ID)
	}
	return LayoutDecision{AtMs: atMs, Policy: policy.Version, PrimaryType: primaryType, PrimaryID: primaryID, Strip: strip}, nil
}

// ActiveSpeakerSelector intentionally leaves the audio-level provider outside
// this package. Implementations feed a bounded deterministic level stream here.
type ActiveSpeakerSelector struct {
	Current        string
	Candidate      string
	CandidateSince int64
	HysteresisMs   int64
}

type SpeakerLevel struct {
	AtMs          int64
	ParticipantID string
	Level         int
	Muted         bool
}

func (s *ActiveSpeakerSelector) Observe(levels []SpeakerLevel, atMs int64) string {
	best := ""
	bestLevel := -1
	for _, level := range levels {
		if level.AtMs > atMs || level.Muted || level.Level < 0 {
			continue
		}
		if level.Level > bestLevel || (level.Level == bestLevel && level.ParticipantID < best) {
			best, bestLevel = level.ParticipantID, level.Level
		}
	}
	if best == "" {
		return s.Current
	}
	if s.Current == "" {
		s.Current = best
		return s.Current
	}
	if best == s.Current {
		s.Candidate = ""
		return s.Current
	}
	if s.Candidate != best {
		s.Candidate, s.CandidateSince = best, atMs
		return s.Current
	}
	if atMs-s.CandidateSince >= s.HysteresisMs {
		s.Current, s.Candidate = best, ""
	}
	return s.Current
}
