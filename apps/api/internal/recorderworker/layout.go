package recorderworker

const MaxStripParticipants = 6

type LayoutPolicy struct {
	Version       string `json:"version"`
	StripLimit    int    `json:"strip_limit"`
	HysteresisMs  int64  `json:"hysteresis_ms"`
	AudioWindowMs int64  `json:"audio_window_ms"`
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
