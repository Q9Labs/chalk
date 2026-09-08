package recordingdecode

import (
	"context"
	"errors"

	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

const (
	SchemaVersion              = "decoded_media.v1"
	IndexFileName              = "decoded_media.json"
	MaximumBundleFiles         = 2_048
	MaximumInputBytes    int64 = 16 << 30
	MaximumOutputBytes   int64 = 32 << 30
	MaximumCommandOutput       = 64 << 10
)

var (
	ErrInvalidRequest = errors.New("invalid decoded media request")
	ErrInvalidBundle  = errors.New("invalid decoded media bundle")
	ErrDecode         = errors.New("recording media decode failed")
	ErrOutputLimit    = errors.New("decoded media output limit exceeded")
)

type BundleFile struct {
	Path                   string
	ExpectedSHA256         string
	Sequence               uint64
	CaptureEpoch           int64
	CaptureJobID           string
	RecorderEnvelopeDigest string
}

type DataKey struct {
	CaptureEpoch int64
	Plaintext    []byte
}

type CommandRunner interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
}

type Request struct {
	RecordingID       string
	EpisodeID         string
	TenantID          string
	Environment       string
	OriginAuthorityID string
	CaptureEpoch      int64
	DurationMS        int64
	OutputDirectory   string
	FFmpegPath        string
	Presentation      recordingpresentation.Timeline
	Bundles           []BundleFile
	DataKeys          []DataKey
	Runner            CommandRunner
}

type Result struct {
	Index       Index
	IndexPath   string
	IndexSHA256 string
}

type Index struct {
	SchemaVersion   string          `json:"schema_version"`
	RecordingID     string          `json:"recording_id"`
	EpisodeID       string          `json:"episode_id"`
	Clock           Clock           `json:"clock"`
	Sources         []Source        `json:"sources"`
	Mix             Mix             `json:"mix"`
	Discontinuities []Discontinuity `json:"discontinuities"`
}

type Clock struct {
	Origin            string `json:"origin"`
	Timebase          string `json:"timebase"`
	OriginAuthorityID string `json:"origin_authority_id"`
	CaptureEpoch      int64  `json:"capture_epoch"`
	DurationMS        int64  `json:"duration_ms"`
}

type Source struct {
	SourceID              string `json:"source_id"`
	ParticipantID         string `json:"participant_id"`
	ParticipantGeneration int64  `json:"participant_generation"`
	TrackID               string `json:"track_id"`
	TrackEpoch            int64  `json:"track_epoch"`
	Kind                  string `json:"kind"`
	Codec                 string `json:"codec"`
	Container             string `json:"container"`
	ContentType           string `json:"content_type"`
	Path                  string `json:"path"`
	ByteSize              int64  `json:"byte_size"`
	SHA256                string `json:"sha256"`
	StartMS               int64  `json:"start_ms"`
	EndMS                 int64  `json:"end_ms"`
	SampleRateHz          *int   `json:"sample_rate_hz,omitempty"`
	Channels              *int   `json:"channels,omitempty"`
}

type Mix struct {
	Path         string `json:"path"`
	Codec        string `json:"codec"`
	Container    string `json:"container"`
	ContentType  string `json:"content_type"`
	SampleRateHz int    `json:"sample_rate_hz"`
	Channels     int    `json:"channels"`
	ByteSize     int64  `json:"byte_size"`
	SHA256       string `json:"sha256"`
	StartMS      int64  `json:"start_ms"`
	EndMS        int64  `json:"end_ms"`
}

type Discontinuity struct {
	SourceID   string `json:"source_id"`
	TrackID    string `json:"track_id"`
	TrackEpoch int64  `json:"track_epoch"`
	StartMS    int64  `json:"start_ms"`
	EndMS      int64  `json:"end_ms"`
	Reason     string `json:"reason"`
}
