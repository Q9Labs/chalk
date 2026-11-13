package recordingpresentation

type Event interface {
	eventBase() EventBase
}

type EventBase struct {
	AtMillis int64 `json:"atMs"`
	Sequence int   `json:"sequence"`
}

type ParticipantJoinedEvent struct {
	EventBase
	Kind        string      `json:"kind"`
	Participant Participant `json:"participant"`
}

func (event ParticipantJoinedEvent) eventBase() EventBase { return event.EventBase }

type ParticipantLeftEvent struct {
	EventBase
	Kind          string `json:"kind"`
	ParticipantID string `json:"participantId"`
}

func (event ParticipantLeftEvent) eventBase() EventBase { return event.EventBase }

type ParticipantDisplayNameChangedEvent struct {
	EventBase
	Kind          string `json:"kind"`
	ParticipantID string `json:"participantId"`
	DisplayName   string `json:"displayName"`
}

func (event ParticipantDisplayNameChangedEvent) eventBase() EventBase { return event.EventBase }

type ParticipantHandRaisedChangedEvent struct {
	EventBase
	Kind          string `json:"kind"`
	ParticipantID string `json:"participantId"`
	Raised        bool   `json:"raised"`
}

func (event ParticipantHandRaisedChangedEvent) eventBase() EventBase { return event.EventBase }

type ParticipantMicrophoneChangedEvent struct {
	EventBase
	Kind          string `json:"kind"`
	ParticipantID string `json:"participantId"`
	Muted         bool   `json:"muted"`
}

func (event ParticipantMicrophoneChangedEvent) eventBase() EventBase { return event.EventBase }

type ParticipantCameraChangedEvent struct {
	EventBase
	Kind          string `json:"kind"`
	ParticipantID string `json:"participantId"`
	Enabled       bool   `json:"enabled"`
}

func (event ParticipantCameraChangedEvent) eventBase() EventBase { return event.EventBase }

type ParticipantScreenShareChangedEvent struct {
	EventBase
	Kind          string `json:"kind"`
	ParticipantID string `json:"participantId"`
	Enabled       bool   `json:"enabled"`
}

func (event ParticipantScreenShareChangedEvent) eventBase() EventBase { return event.EventBase }

type ParticipantSpeakingChangedEvent struct {
	EventBase
	Kind          string `json:"kind"`
	ParticipantID string `json:"participantId"`
	Speaking      bool   `json:"speaking"`
}

func (event ParticipantSpeakingChangedEvent) eventBase() EventBase { return event.EventBase }

type ActiveSpeakerChangedEvent struct {
	EventBase
	Kind          string  `json:"kind"`
	ParticipantID *string `json:"participantId"`
}

func (event ActiveSpeakerChangedEvent) eventBase() EventBase { return event.EventBase }

type MediaSourceChangedEvent struct {
	EventBase
	Kind   string      `json:"kind"`
	Source MediaSource `json:"source"`
}

func (event MediaSourceChangedEvent) eventBase() EventBase { return event.EventBase }

type ChatMessageAddedEvent struct {
	EventBase
	Kind    string      `json:"kind"`
	Message ChatMessage `json:"message"`
}

func (event ChatMessageAddedEvent) eventBase() EventBase { return event.EventBase }

type ReactionAddedEvent struct {
	EventBase
	Kind     string   `json:"kind"`
	Reaction Reaction `json:"reaction"`
}

func (event ReactionAddedEvent) eventBase() EventBase { return event.EventBase }

type SharedContentChangedEvent struct {
	EventBase
	Kind          string        `json:"kind"`
	SharedContent SharedContent `json:"sharedContent"`
}

func (event SharedContentChangedEvent) eventBase() EventBase { return event.EventBase }
