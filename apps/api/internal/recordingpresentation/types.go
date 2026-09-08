package recordingpresentation

import "encoding/json"

const (
	SchemaVersion       = "recording_presentation.v1"
	MaximumTimelineSize = 64 << 20
	MaximumEvents       = 100_000
	MaximumAssets       = 256
	MaximumParticipants = 500
	MaximumMediaSources = 1_000
	MaximumChatMessages = 100
	MaximumReactions    = 500
	maximumSafeInteger  = int64(9_007_199_254_740_991)
)

type Timeline struct {
	SchemaVersion string        `json:"schemaVersion"`
	RecordingID   string        `json:"recordingId"`
	EpisodeID     string        `json:"episodeId"`
	Clock         Clock         `json:"clock"`
	SourceCursors SourceCursors `json:"sourceCursors"`
	Initial       Snapshot      `json:"initial"`
	Events        []Event       `json:"-"`
	Assets        []Asset       `json:"assets"`
}

type Clock struct {
	Origin            string `json:"origin"`
	Timebase          string `json:"timebase"`
	CaptureEpoch      int64  `json:"captureEpoch"`
	OriginAuthorityID string `json:"originAuthorityId"`
	DurationMillis    int64  `json:"durationMs"`
}

type SourceCursors struct {
	EpisodeControlStartRevision int64 `json:"episodeControlStartRevision"`
	EpisodeControlEndRevision   int64 `json:"episodeControlEndRevision"`
	ChatStartSequence           int64 `json:"chatStartSequence"`
	ChatEndSequence             int64 `json:"chatEndSequence"`
	WhiteboardStartRevision     int64 `json:"whiteboardStartRevision"`
	WhiteboardEndRevision       int64 `json:"whiteboardEndRevision"`
	CapturePlanStartRevision    int64 `json:"capturePlanStartRevision"`
	CapturePlanEndRevision      int64 `json:"capturePlanEndRevision"`
}

type Snapshot struct {
	ElapsedMillis int64         `json:"elapsedMs"`
	Profile       Profile       `json:"profile"`
	Space         Space         `json:"space"`
	View          View          `json:"view"`
	Participants  []Participant `json:"participants"`
	Media         []MediaSource `json:"media"`
	Chat          Chat          `json:"chat"`
	SharedContent SharedContent `json:"sharedContent"`
	Reactions     []Reaction    `json:"reactions"`
}

type Profile struct {
	Name          string   `json:"name"`
	Version       string   `json:"version"`
	UIBuildSHA256 string   `json:"uiBuildSha256"`
	Viewport      Viewport `json:"viewport"`
	Locale        string   `json:"locale"`
	TimeZone      string   `json:"timeZone"`
	FontAssetIDs  []string `json:"fontAssetIds"`
	Theme         Theme    `json:"theme"`
}

type Viewport struct {
	Width             int     `json:"width"`
	Height            int     `json:"height"`
	DeviceScaleFactor float64 `json:"deviceScaleFactor"`
}

type Theme struct {
	ColorScheme      string `json:"colorScheme"`
	Skin             string `json:"skin"`
	Palette          string `json:"palette"`
	Texture          string `json:"texture"`
	StageBackground  bool   `json:"stageBackground"`
	GeneratedAvatars bool   `json:"generatedAvatars"`
}

type Space struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	LogoAssetID string `json:"logoAssetId,omitempty"`
}

type View struct {
	Layout  string `json:"layout"`
	Sidebar string `json:"sidebar"`
}

type Participant struct {
	ID                 string `json:"id"`
	DisplayName        string `json:"displayName"`
	JoinOrdinal        int64  `json:"joinOrdinal"`
	Joined             bool   `json:"joined"`
	MicrophoneMuted    bool   `json:"microphoneMuted"`
	CameraEnabled      bool   `json:"cameraEnabled"`
	ScreenShareEnabled bool   `json:"screenShareEnabled"`
	Speaking           bool   `json:"speaking"`
	ActiveSpeaker      bool   `json:"activeSpeaker"`
	HandRaised         bool   `json:"handRaised"`
	AvatarAssetID      string `json:"avatarAssetId,omitempty"`
}

type Attachment struct {
	ID          string `json:"id"`
	AssetID     string `json:"assetId"`
	FileName    string `json:"fileName"`
	ContentType string `json:"contentType"`
	ByteSize    int64  `json:"byteSize"`
}

type ChatMessage struct {
	ID              string       `json:"id"`
	Sequence        int64        `json:"sequence"`
	ParticipantID   string       `json:"participantId"`
	DisplayName     string       `json:"displayName"`
	Text            string       `json:"text"`
	CreatedAtMillis int64        `json:"createdAtMs"`
	DisplayTime     string       `json:"displayTime"`
	Attachments     []Attachment `json:"attachments"`
}

type Chat struct {
	RetainedFloorSequence *int64        `json:"retainedFloorSequence"`
	HeadSequence          int64         `json:"headSequence"`
	Messages              []ChatMessage `json:"messages"`
}

type Reaction struct {
	ID               string `json:"id"`
	ParticipantID    string `json:"participantId"`
	DisplayName      string `json:"displayName"`
	Value            string `json:"value"`
	OccurredAtMillis int64  `json:"occurredAtMs"`
	ExpiresAtMillis  int64  `json:"expiresAtMs"`
}

type MediaSource struct {
	SourceID              string    `json:"sourceId"`
	ParticipantID         string    `json:"participantId"`
	ParticipantGeneration int64     `json:"participantGeneration"`
	Kind                  MediaKind `json:"kind"`
	TrackID               string    `json:"trackId"`
	Epoch                 int64     `json:"epoch"`
	Visible               bool      `json:"visible"`
}

type SharedContent struct {
	Kind          string `json:"kind"`
	ParticipantID string `json:"participantId,omitempty"`
	SourceID      string `json:"sourceId,omitempty"`
	SceneID       string `json:"sceneId,omitempty"`
	Revision      int64  `json:"revision,omitempty"`
	StateAssetID  string `json:"stateAssetId,omitempty"`
}

type Asset struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	ObjectKey   string `json:"objectKey"`
	ContentType string `json:"contentType"`
	ByteSize    int64  `json:"byteSize"`
	SHA256      string `json:"sha256"`
}

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

type timelineWire struct {
	SchemaVersion string            `json:"schemaVersion"`
	RecordingID   string            `json:"recordingId"`
	EpisodeID     string            `json:"episodeId"`
	Clock         Clock             `json:"clock"`
	SourceCursors SourceCursors     `json:"sourceCursors"`
	Initial       Snapshot          `json:"initial"`
	Events        []json.RawMessage `json:"events"`
	Assets        []Asset           `json:"assets"`
}
