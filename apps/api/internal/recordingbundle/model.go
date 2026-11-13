package recordingbundle

import (
	"errors"
)

const (
	LegacyVersion = "recording_bundle.v1"
	Version       = "recording_bundle.v2"

	TargetBundleDurationMilliseconds int64 = 10_000
	MaxBundleDurationMilliseconds    int64 = 15_000

	// The recording policy caps input at 4 Mbps. This is the largest amount of
	// raw RTP payload that can belong to one 15 second bundle.
	RecordingBitrateBitsPerSecond = 4_000_000
	MaxContentBytes               = RecordingBitrateBitsPerSecond / 8 * (MaxBundleDurationMilliseconds / 1_000)

	MaxPacketPayloadBytes = 64 * 1024
	MaxPackets            = 100_000
	MaxTracks             = 64
	MaxTimelineEvents     = 1_024
	MaxGaps               = 1_024
	MaxIdentifierBytes    = 512

	// Track epochs combine the capture attempt epoch with its attempt-local
	// plan revision into one JSON-safe integer. Epoch one retains the legacy
	// plan-revision values.
	MaxTrackEpochCaptureEpoch uint64 = 1 << 21
	MaxTrackEpochPlanRevision uint64 = 1<<32 - 1
)

var (
	ErrInvalidBundle          = errors.New("recording bundle is invalid")
	ErrUnknownBundleVersion   = errors.New("recording bundle version is unknown")
	ErrUnknownField           = errors.New("recording bundle contains an unknown field")
	ErrDigestMismatch         = errors.New("recording bundle digest does not match")
	ErrContentLimit           = errors.New("recording bundle content limit exceeded")
	ErrPacketLimit            = errors.New("recording bundle packet limit exceeded")
	ErrDurationLimit          = errors.New("recording bundle duration limit exceeded")
	ErrAssemblerClosed        = errors.New("recording bundle assembler is closed")
	ErrAssemblerNotClosed     = errors.New("recording bundle assembler is not closed")
	ErrEmptyBundle            = errors.New("recording bundle has no content")
	ErrTrackEpochChangeNeeded = errors.New("recording bundle track epoch change must be explicit")
	ErrTrackIdentityMutation  = errors.New("recording bundle track identity changed")
	ErrInvalidTrackEpoch      = errors.New("recording bundle track epoch is invalid")
	ErrNonMonotonicTime       = errors.New("recording bundle event time is invalid")
)

// ComposeTrackEpoch creates the identity shared by capture bundles and the
// recording presentation. The result never exceeds JavaScript's largest
// exactly representable integer.
func ComposeTrackEpoch(captureEpoch, planRevision uint64) (uint64, error) {
	if captureEpoch == 0 || captureEpoch > MaxTrackEpochCaptureEpoch ||
		planRevision == 0 || planRevision > MaxTrackEpochPlanRevision {
		return 0, ErrInvalidTrackEpoch
	}
	return (captureEpoch-1)<<32 | planRevision, nil
}

type CloseReason string

const (
	CloseReasonCadence        CloseReason = "cadence"
	CloseReasonMaxDuration    CloseReason = "max_duration"
	CloseReasonTrackSetChange CloseReason = "track_set_change"
	CloseReasonFinalStop      CloseReason = "final_stop"
	CloseReasonLimitExceeded  CloseReason = "limit_exceeded"
	CloseReasonExplicit       CloseReason = "explicit"
)

func (r CloseReason) valid() bool {
	switch r {
	case CloseReasonCadence, CloseReasonMaxDuration, CloseReasonTrackSetChange,
		CloseReasonFinalStop, CloseReasonLimitExceeded, CloseReasonExplicit:
		return true
	default:
		return false
	}
}

// TimeRange is expressed in Unix-relative milliseconds. The range is closed:
// EndMilliseconds is the last included media/monotonic boundary and is never
// less than StartMilliseconds.
type TimeRange struct {
	StartMilliseconds int64 `json:"start_ms"`
	EndMilliseconds   int64 `json:"end_ms"`
}

// EncryptionContext contains only non-secret AAD and audit context. It never
// carries a plaintext key, a key blob, or reusable provider credentials.
type EncryptionContext struct {
	Environment  string `json:"environment"`
	TenantID     string `json:"tenant_id"`
	EpisodeID    string `json:"episode_id"`
	RecordingID  string `json:"recording_id"`
	JobID        string `json:"job_id"`
	BundleSchema string `json:"bundle_schema"`
	KeyHandle    string `json:"key_handle,omitempty"`
}

// Manifest authenticates the identity and range of one sealed bundle.
type Manifest struct {
	Version                string      `json:"version"`
	RecordingID            string      `json:"recording_id"`
	CaptureEpoch           uint64      `json:"capture_epoch"`
	Sequence               uint64      `json:"sequence"`
	RecorderEnvelopeDigest string      `json:"recorder_envelope_digest"`
	MonotonicRange         TimeRange   `json:"monotonic_range"`
	MediaRange             TimeRange   `json:"media_range"`
	CloseReason            CloseReason `json:"close_reason"`
	ContentSHA256          string      `json:"content_sha256"`
	// AllocationVersion is assigned by the API before assembly. The object
	// provider version is only known after upload and is persisted separately
	// when the API verifies and commits the object.
	AllocationVersion int64             `json:"allocation_version"`
	Encryption        EncryptionContext `json:"encryption"`
}

// TrackIdentity is immutable for the lifetime of one track epoch. A changed
// epoch or binding must be represented by a timeline event before packets use
// the new identity.
type TrackIdentity struct {
	TrackID string `json:"track_id"`
	Epoch   uint64 `json:"epoch"`
	MID     string `json:"mid"`
	Codec   string `json:"codec"`
	Layer   string `json:"layer"`
}

// RTPPacket is the adapter-neutral subset needed to retain codec-native RTP.
// Capture normalizes Timestamp to the recording clock origin using the codec
// clock rate (48 kHz Opus, 90 kHz VP8/H264). A late or replacement source
// therefore starts at its recording-relative offset instead of zero. Payload
// is copied by Assembler.AddPacket and is never retained by reference to a
// caller-owned buffer.
type RTPPacket struct {
	SequenceNumber         uint16 `json:"sequence_number"`
	ExtendedSequenceNumber uint64 `json:"extended_sequence_number"`
	Timestamp              uint32 `json:"timestamp"`
	SSRC                   uint32 `json:"ssrc"`
	PayloadType            uint8  `json:"payload_type"`
	Marker                 bool   `json:"marker"`
	Payload                []byte `json:"payload"`
}

// MediaPacket carries recording-relative arrival and media clocks alongside
// one copied RTP packet. Zero is the first authoritative capture-ready instant
// persisted for the Recording and is shared across tracks and capture attempts.
// RTP timestamp ordering remains separate from the media/monotonic ranges.
type MediaPacket struct {
	Track                 TrackIdentity `json:"track"`
	Packet                RTPPacket     `json:"packet"`
	MonotonicMilliseconds int64         `json:"monotonic_ms"`
	MediaMilliseconds     int64         `json:"media_ms"`
}

type RTPFragment struct {
	Track   TrackIdentity `json:"track"`
	Packets []RTPPacket   `json:"packets"`
}

type TrackEventKind string

const (
	TrackEventAdded        TrackEventKind = "added"
	TrackEventRemoved      TrackEventKind = "removed"
	TrackEventReplaced     TrackEventKind = "replaced"
	TrackEventEpochChanged TrackEventKind = "epoch_changed"
)

type TrackTimelineEvent struct {
	MonotonicMilliseconds int64          `json:"monotonic_ms"`
	MediaMilliseconds     int64          `json:"media_ms"`
	Kind                  TrackEventKind `json:"kind"`
	Track                 TrackIdentity  `json:"track"`
	Reason                string         `json:"reason"`
}

type LayoutEventKind string

const (
	LayoutEventSnapshot LayoutEventKind = "snapshot"
	LayoutEventChanged  LayoutEventKind = "changed"
)

type LayoutTimelineEvent struct {
	MonotonicMilliseconds int64           `json:"monotonic_ms"`
	MediaMilliseconds     int64           `json:"media_ms"`
	Kind                  LayoutEventKind `json:"kind"`
	Revision              uint64          `json:"revision"`
	Layout                string          `json:"layout"`
}

// Gap is explicit missing media. ReplacementAttempt identifies a worker
// replacement boundary; Terminal marks a read-side terminal gap.
type Gap struct {
	StartMonotonicMilliseconds int64  `json:"start_monotonic_ms"`
	EndMonotonicMilliseconds   int64  `json:"end_monotonic_ms"`
	StartMediaMilliseconds     int64  `json:"start_media_ms"`
	EndMediaMilliseconds       int64  `json:"end_media_ms"`
	Reason                     string `json:"reason"`
	ReplacementAttempt         uint64 `json:"replacement_attempt"`
	Terminal                   bool   `json:"terminal"`
}

// Bundle is the decoded, immutable logical representation of either stored
// bundle version. Digest fields are populated by Encode and verified by Decode.
type Bundle struct {
	Version        string                `json:"version"`
	Manifest       Manifest              `json:"manifest"`
	Fragments      []RTPFragment         `json:"fragments"`
	TrackTimeline  []TrackTimelineEvent  `json:"track_timeline"`
	LayoutTimeline []LayoutTimelineEvent `json:"layout_timeline"`
	Gaps           []Gap                 `json:"gaps"`
	ManifestDigest string                `json:"manifest_digest"`
	ContentDigest  string                `json:"content_digest"`
	BundleDigest   string                `json:"bundle_digest"`
}
