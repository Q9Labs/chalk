package recordingbundle

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

const (
	// Version is frozen. A change to the wire contract requires a new version.
	Version = "recording_bundle.v1"

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
	ErrNonMonotonicTime       = errors.New("recording bundle event time is invalid")
)

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
// Payload is copied by Assembler.AddPacket and is never retained by reference
// to a caller-owned buffer.
type RTPPacket struct {
	SequenceNumber         uint16 `json:"sequence_number"`
	ExtendedSequenceNumber uint64 `json:"extended_sequence_number"`
	Timestamp              uint32 `json:"timestamp"`
	SSRC                   uint32 `json:"ssrc"`
	PayloadType            uint8  `json:"payload_type"`
	Marker                 bool   `json:"marker"`
	Payload                []byte `json:"payload"`
}

// MediaPacket carries the two worker clocks alongside one copied RTP packet.
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

// Bundle is the decoded, immutable logical representation of one
// recording_bundle.v1 envelope. Digest fields are populated by Encode and
// verified by Decode.
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

func validateIdentifier(name, value string, required bool) error {
	if !required && value == "" {
		return nil
	}
	if strings.TrimSpace(value) == "" || len(value) > MaxIdentifierBytes || !utf8.ValidString(value) {
		return fmt.Errorf("%w: %s is invalid", ErrInvalidBundle, name)
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("%w: %s contains a control character", ErrInvalidBundle, name)
		}
	}
	return nil
}

func (r TimeRange) validate(name string) error {
	if r.StartMilliseconds < 0 || r.EndMilliseconds < r.StartMilliseconds {
		return fmt.Errorf("%w: %s range is invalid", ErrInvalidBundle, name)
	}
	return nil
}

func (c EncryptionContext) validate() error {
	for name, value := range map[string]string{
		"environment":   c.Environment,
		"tenant_id":     c.TenantID,
		"episode_id":    c.EpisodeID,
		"recording_id":  c.RecordingID,
		"job_id":        c.JobID,
		"bundle_schema": c.BundleSchema,
	} {
		if err := validateIdentifier(name, value, true); err != nil {
			return err
		}
	}
	if c.BundleSchema != Version {
		return fmt.Errorf("%w: encryption bundle schema %q", ErrUnknownBundleVersion, c.BundleSchema)
	}
	return nil
}

func (t TrackIdentity) validate() error {
	for name, value := range map[string]string{
		"track_id": t.TrackID,
		"mid":      t.MID,
		"codec":    t.Codec,
		"layer":    t.Layer,
	} {
		if err := validateIdentifier(name, value, true); err != nil {
			return err
		}
	}
	if t.Epoch == 0 {
		return fmt.Errorf("%w: track epoch must be positive", ErrInvalidBundle)
	}
	return nil
}

func (m Manifest) validate() error {
	if m.Version != Version {
		return fmt.Errorf("%w: manifest version %q", ErrUnknownBundleVersion, m.Version)
	}
	if err := validateIdentifier("recording_id", m.RecordingID, true); err != nil {
		return err
	}
	if m.CaptureEpoch == 0 {
		return fmt.Errorf("%w: capture epoch must be positive", ErrInvalidBundle)
	}
	if !validSHA256Hex(m.RecorderEnvelopeDigest) {
		return fmt.Errorf("%w: recorder envelope digest is invalid", ErrInvalidBundle)
	}
	if m.AllocationVersion <= 0 {
		return fmt.Errorf("%w: allocation version must be positive", ErrInvalidBundle)
	}
	if err := m.MonotonicRange.validate("monotonic"); err != nil {
		return err
	}
	if err := m.MediaRange.validate("media"); err != nil {
		return err
	}
	if !m.CloseReason.valid() {
		return fmt.Errorf("%w: close reason %q", ErrInvalidBundle, m.CloseReason)
	}
	if m.ContentSHA256 != "" && len(m.ContentSHA256) != 64 {
		return fmt.Errorf("%w: content checksum is invalid", ErrInvalidBundle)
	}
	if err := m.Encryption.validate(); err != nil {
		return err
	}
	if m.Encryption.RecordingID != m.RecordingID {
		return fmt.Errorf("%w: encryption recording does not match manifest", ErrInvalidBundle)
	}
	return nil
}

func validSHA256Hex(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, char := range value {
		if !(char >= '0' && char <= '9') && !(char >= 'a' && char <= 'f') {
			return false
		}
	}
	return true
}

func (t TrackEventKind) valid() bool {
	switch t {
	case TrackEventAdded, TrackEventRemoved, TrackEventReplaced, TrackEventEpochChanged:
		return true
	default:
		return false
	}
}

func (l LayoutEventKind) valid() bool {
	return l == LayoutEventSnapshot || l == LayoutEventChanged
}

func (g Gap) validate() error {
	if g.StartMonotonicMilliseconds < 0 || g.EndMonotonicMilliseconds < g.StartMonotonicMilliseconds || g.StartMediaMilliseconds < 0 || g.EndMediaMilliseconds < g.StartMediaMilliseconds {
		return fmt.Errorf("%w: gap range is invalid", ErrInvalidBundle)
	}
	if err := validateIdentifier("gap reason", g.Reason, true); err != nil {
		return err
	}
	if g.ReplacementAttempt == 0 && g.Terminal {
		return nil
	}
	return nil
}

// ValidateSequence verifies the cross-bundle ordering contract. A worker may
// recover after a crash with a new capture epoch, but it must never reuse a
// sequence number for the same recording.
func ValidateSequence(previous, next Bundle) error {
	if previous.Manifest.RecordingID != next.Manifest.RecordingID {
		return fmt.Errorf("%w: recording identity changed", ErrInvalidBundle)
	}
	if next.Manifest.Sequence <= previous.Manifest.Sequence {
		return fmt.Errorf("%w: bundle sequence is not strictly increasing", ErrInvalidBundle)
	}
	if next.Manifest.MonotonicRange.StartMilliseconds < previous.Manifest.MonotonicRange.EndMilliseconds {
		return fmt.Errorf("%w: bundle ranges overlap", ErrInvalidBundle)
	}
	return nil
}
