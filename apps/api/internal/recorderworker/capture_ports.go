package recorderworker

import (
	"context"
	"strings"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

// CaptureKeyRequest is the least authority needed to retrieve one plaintext
// recording key. Implementations must use the scoped key handle and must not
// persist the returned bytes.
type CaptureKeyRequest struct {
	TenantID          string
	SpaceID           string
	EpisodeID         string
	RecordingID       string
	JobID             string
	KeyHandle         string
	CaptureEpoch      uint64
	Attempt           int
	FencingGeneration int64
	LeaseOwner        string
	LeaseToken        string
	LeaseExpiresAt    time.Time
	EnvelopeDigest    string
}

type CaptureDataKey struct {
	Plaintext               []byte
	EncryptionContextDigest []byte
}

// CaptureKeyPort is intentionally separate from object storage. A key access
// implementation can use the worker mTLS channel without giving that channel
// access to an object URL.
type CaptureKeyPort interface {
	AccessKey(context.Context, CaptureKeyRequest) (CaptureDataKey, error)
}

// BundleReserveRequest asks the API to allocate the next server-owned bundle
// sequence and object key. The worker never chooses either value.
type BundleReserveRequest struct {
	TenantID                string
	SpaceID                 string
	EpisodeID               string
	RecordingID             string
	JobID                   string
	ObjectHandle            string
	CaptureEpoch            uint64
	Attempt                 int
	FencingGeneration       int64
	LeaseOwner              string
	LeaseToken              string
	LeaseExpiresAt          time.Time
	EnvelopeDigest          string
	ReservationRequestID    string
	EncryptionContextDigest []byte
}

// BundleReservation is an opaque object allocation returned by the API. The
// allocation version is included in the authenticated bundle manifest before
// bytes are encrypted.
type BundleReservation struct {
	ReservationID     string
	Sequence          uint64
	AllocationVersion int64
	ObjectKey         string
}

type CaptureBundleFinalize struct {
	Authority    BundleReserveRequest
	Reservation  BundleReservation
	Bundle       recordingbundle.Bundle
	ObjectSize   int64
	ObjectSHA256 string
	ContentType  string
	Codec        string
	Layer        *string
}

type CaptureBundleUpload struct {
	Reservation BundleReservation
	UploadToken string
	SignedURL   objectstorage.SignedURL
}

// CaptureObjectUpload is the exact encrypted object sent to storage. The
// object port must use a client without the recorder mTLS certificate.
type CaptureObjectUpload struct {
	Upload      CaptureBundleUpload
	Body        []byte
	ContentType string
	Checksum    string
}

// CaptureObjectPort owns the object-storage upload edge. It receives only a
// scoped reservation and encrypted bytes, never a worker client certificate.
type CaptureObjectPort interface {
	Upload(context.Context, CaptureObjectUpload) error
}

// CaptureBundleCommit records the API-side facts after object storage has
// accepted the encrypted bytes. The bundle is included for metadata indexing.
type CaptureBundleCommit struct {
	Authority    BundleReserveRequest
	Reservation  BundleReservation
	UploadToken  string
	Bundle       recordingbundle.Bundle
	ObjectSize   int64
	ObjectSHA256 string
	ContentType  string
}

// CaptureBundleSink reserves sequence numbers and commits verified object
// metadata. Upload and commit remain separate so the API can HEAD and fence
// the object before accepting the row.
type CaptureBundleSink interface {
	Reserve(context.Context, BundleReserveRequest) (BundleReservation, error)
	Finalize(context.Context, CaptureBundleFinalize) (CaptureBundleUpload, error)
	Commit(context.Context, CaptureBundleCommit) error
}

// CaptureReadyEvent is emitted once the API can move a recording from
// starting to recording. NoPublisher is explicit when the initial plan has
// no media tracks; otherwise readiness requires the first RTP packet.
type CaptureReadyEvent struct {
	TenantID          string
	SpaceID           string
	EpisodeID         string
	RecordingID       string
	JobID             string
	CaptureEpoch      uint64
	Attempt           int
	FencingGeneration int64
	EnvelopeDigest    string
	LeaseOwner        string
	LeaseToken        string
	LeaseExpiresAt    time.Time
	At                time.Time
	IdempotencyKey    string
	NoPublisher       bool
}

// CaptureStoppedEvent is emitted only after all durable bundles are committed
// and the provider capture connection is closed.
type CaptureStoppedEvent struct {
	TenantID          string
	SpaceID           string
	EpisodeID         string
	RecordingID       string
	JobID             string
	CaptureEpoch      uint64
	Attempt           int
	FencingGeneration int64
	EnvelopeDigest    string
	LeaseOwner        string
	LeaseToken        string
	LeaseExpiresAt    time.Time
	At                time.Time
	IdempotencyKey    string
}

// CaptureLifecyclePort lets the API project durable capture transitions into
// Sync. Implementations must fence both events by epoch and attempt.
type CaptureLifecyclePort interface {
	Ready(context.Context, CaptureReadyEvent) error
	Stopped(context.Context, CaptureStoppedEvent) error
}

// CaptureMediaTrack is the bounded RTP surface required by the runtime. The
// concrete Pion track is wrapped so tests can use a deterministic reader.
type CaptureMediaTrack interface {
	CaptureTrack() captureplane.PulledCaptureTrack
	MID() captureplane.ProviderReference
	Codec() string
	RID() string
	ReadRTP() (*rtp.Packet, interceptor.Attributes, error)
	SetReadDeadline(time.Time) error
}

// CapturePeer is one epoch's Pion connection and its provider-neutral
// signaling methods. A factory must return exactly one instance per claim.
type CapturePeer interface {
	recordercapture.PeerPort
	Epoch() captureplane.CaptureEpoch
	WaitForTrack(context.Context, captureplane.ProviderReference) (CaptureMediaTrack, error)
	RequestKeyFrame(captureplane.ProviderReference) error
	Error() error
	Close() error
}

// CaptureAttemptConfig controls bounded waits in one capture attempt.
type CaptureAttemptConfig struct {
	Environment     string
	InitialPlanWait time.Duration
	PlanWait        time.Duration
	// LateTrackWait bounds how long a planned track that sent no RTP at bind
	// time is still attached when its first packet arrives. After it the
	// track is reported missing and stays out of the Recording.
	LateTrackWait   time.Duration
	RTPReadDeadline time.Duration
	CloseTimeout    time.Duration
	// KeyFrameInterval asks each video sender for a keyframe at least this
	// often, so native Exports can seek retained video cheaply. Zero turns it off.
	KeyFrameInterval time.Duration
	Now              func() time.Time
	After            func(time.Duration) <-chan time.Time
}

func (c CaptureAttemptConfig) normalized() CaptureAttemptConfig {
	c.Environment = strings.TrimSpace(c.Environment)
	if c.Environment == "" {
		c.Environment = "local"
	}
	if c.InitialPlanWait <= 0 {
		c.InitialPlanWait = defaultCaptureInitialPlanWait
	}
	if c.InitialPlanWait < captureplan.MinimumWait {
		c.InitialPlanWait = captureplan.MinimumWait
	}
	if c.InitialPlanWait > captureplan.MaximumWait {
		c.InitialPlanWait = captureplan.MaximumWait
	}
	if c.LateTrackWait <= 0 {
		c.LateTrackWait = defaultCaptureLateTrackWait
	}
	if c.PlanWait <= 0 {
		c.PlanWait = defaultCapturePlanWait
	}
	if c.PlanWait < captureplan.MinimumWait {
		c.PlanWait = captureplan.MinimumWait
	}
	if c.PlanWait > captureplan.MaximumWait {
		c.PlanWait = captureplan.MaximumWait
	}
	if c.RTPReadDeadline <= 0 {
		c.RTPReadDeadline = defaultCaptureRTPDeadline
	}
	if c.CloseTimeout <= 0 {
		c.CloseTimeout = defaultCaptureCloseTimeout
	}
	if c.After == nil {
		c.After = time.After
	}
	if c.Now == nil {
		c.Now = func() time.Time { return time.Now().UTC() }
	}
	return c
}
