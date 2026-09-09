package recorderworker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/adapters/pion"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	defaultCaptureInitialPlanWait = 10 * time.Second
	defaultCapturePlanWait        = 2 * time.Second
	defaultCaptureRTPDeadline     = 250 * time.Millisecond
	defaultCaptureCloseTimeout    = 15 * time.Second
	captureVideoReorderWindow     = uint64(16)
	captureKeyFrameRequestSpacing = time.Second
	captureBundleContentType      = "application/vnd.chalk.recording-bundle+json"
)

var (
	ErrInvalidCaptureAttempt = errors.New("invalid recorder capture attempt")
	ErrCaptureEventQueueFull = errors.New("recorder capture event queue is full")
	ErrCapturePeerTerminal   = errors.New("recorder capture peer reached a terminal state")
	ErrCaptureStorage        = errors.New("recorder capture storage is unavailable")
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
	RTPReadDeadline time.Duration
	CloseTimeout    time.Duration
	Now             func() time.Time
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
	if c.Now == nil {
		c.Now = func() time.Time { return time.Now().UTC() }
	}
	return c
}

// PionCaptureAttemptFactory creates a single peer and coordinator for each
// server-issued claim. CaptureEpoch is read from the envelope and is never
// incremented by this factory.
type PionCaptureAttemptFactory struct {
	signaling capturesignalingPort
	plans     recordercapture.PlanSource
	keys      CaptureKeyPort
	objects   CaptureObjectPort
	bundles   CaptureBundleSink
	lifecycle CaptureLifecyclePort
	peer      func(pion.Config) (CapturePeer, error)
	coord     recordercapture.Config
	config    CaptureAttemptConfig
}

type capturesignalingPort = recordercapture.SignalingPort

// PionCaptureAttemptFactoryConfig contains the runtime edges. The production
// peer factory is provided when NewPeer is nil; all storage and lifecycle
// edges remain explicit ports until their authority routes are wired.
type PionCaptureAttemptFactoryConfig struct {
	Signaling   capturesignalingPort
	Plans       recordercapture.PlanSource
	Keys        CaptureKeyPort
	Objects     CaptureObjectPort
	Bundles     CaptureBundleSink
	Lifecycle   CaptureLifecyclePort
	NewPeer     func(pion.Config) (CapturePeer, error)
	Coordinator recordercapture.Config
	Attempt     CaptureAttemptConfig
}

func NewPionCaptureAttemptFactory(config PionCaptureAttemptFactoryConfig) (*PionCaptureAttemptFactory, error) {
	if config.Signaling == nil || config.Plans == nil || config.Keys == nil || config.Objects == nil || config.Bundles == nil || config.Lifecycle == nil {
		return nil, ErrInvalidCaptureAttempt
	}
	if config.NewPeer == nil {
		config.NewPeer = func(peerConfig pion.Config) (CapturePeer, error) {
			peer, err := pion.NewPeer(peerConfig)
			if err != nil {
				return nil, err
			}
			return &capturePionPeer{Peer: peer}, nil
		}
	}
	return &PionCaptureAttemptFactory{
		signaling: config.Signaling,
		plans:     config.Plans,
		keys:      config.Keys,
		objects:   config.Objects,
		bundles:   config.Bundles,
		lifecycle: config.Lifecycle,
		peer:      config.NewPeer,
		coord:     config.Coordinator,
		config:    config.Attempt.normalized(),
	}, nil
}

// NewCaptureAttemptFactory is the shorter constructor used by command
// wiring. It intentionally returns the concrete factory for inspection.
func NewCaptureAttemptFactory(config PionCaptureAttemptFactoryConfig) (*PionCaptureAttemptFactory, error) {
	return NewPionCaptureAttemptFactory(config)
}

func (f *PionCaptureAttemptFactory) NewCaptureAttempt(ctx context.Context, claim ClaimResult) (CaptureAttempt, error) {
	if f == nil || f.peer == nil || f.signaling == nil || f.plans == nil {
		return nil, ErrInvalidCaptureAttempt
	}
	authority, err := recordercapture.NewAttemptAuthority(claim.Envelope, claim.EnvelopeDigest, capturesignaling.WorkerLease{
		Owner: claim.LeaseOwner, Token: claim.LeaseToken, ExpiresAt: claim.LeaseExpiresAt,
	})
	if err != nil {
		return nil, fmt.Errorf("build recorder capture authority: %w", err)
	}
	peer, err := f.peer(pion.Config{CaptureEpoch: authority.CaptureEpoch})
	if err != nil {
		return nil, fmt.Errorf("create capture peer for epoch %d: %w", authority.CaptureEpoch, err)
	}
	if peer == nil || peer.Epoch() != authority.CaptureEpoch {
		if peer != nil {
			_ = peer.Close()
		}
		return nil, fmt.Errorf("%w: peer epoch does not match server epoch", ErrInvalidCaptureAttempt)
	}
	coordinator, err := recordercapture.NewCoordinator(authority, f.signaling, peer, f.coord)
	if err != nil {
		_ = peer.Close()
		return nil, fmt.Errorf("create capture coordinator: %w", err)
	}
	attempt := &PionCaptureAttempt{
		authority:   authority,
		lease:       authority.Lease,
		peer:        peer,
		coordinator: coordinator,
		plans:       f.plans,
		keys:        f.keys,
		objects:     f.objects,
		bundles:     f.bundles,
		lifecycle:   f.lifecycle,
		config:      f.config,
		ready:       authority.CaptureReadyAt != nil,
	}
	return attempt, nil
}

// PionCaptureAttempt runs one server-issued epoch from plan bootstrap to
// provider shutdown. It does not own the job lease; CaptureDaemon renews it.
type PionCaptureAttempt struct {
	mu sync.Mutex

	authority   recordercapture.AttemptAuthority
	lease       capturesignaling.WorkerLease
	peer        CapturePeer
	coordinator captureCoordinator
	plans       recordercapture.PlanSource
	keys        CaptureKeyPort
	objects     CaptureObjectPort
	bundles     CaptureBundleSink
	lifecycle   CaptureLifecyclePort
	config      CaptureAttemptConfig

	running      bool
	closing      bool
	closed       bool
	closeDone    chan struct{}
	closeErr     error
	bootstrapped bool
	ready        bool
	readyEvent   CaptureReadyEvent
}

type captureCoordinator interface {
	Bootstrap(context.Context, captureplan.Plan) (recordercapture.Snapshot, error)
	Reconcile(context.Context, captureplan.Plan) (recordercapture.Snapshot, error)
	Snapshot() (recordercapture.Snapshot, error)
	Close(context.Context, bool) error
	RenewLease(capturesignaling.WorkerLease) error
}

var _ CaptureAttemptFactory = (*PionCaptureAttemptFactory)(nil)
var _ CaptureAttempt = (*PionCaptureAttempt)(nil)

func (a *PionCaptureAttempt) RenewLease(lease capturesignaling.WorkerLease) error {
	if a == nil || a.coordinator == nil {
		return ErrInvalidCaptureAttempt
	}
	if err := a.coordinator.RenewLease(lease); err != nil {
		return err
	}
	a.mu.Lock()
	a.lease = lease
	a.mu.Unlock()
	return nil
}

func (a *PionCaptureAttempt) Close(ctx context.Context) error {
	if a == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	closeCtx, cancel := context.WithTimeout(ctx, a.config.CloseTimeout)
	defer cancel()
	return a.closeLocal(closeCtx, nil, recordingbundle.CloseReasonExplicit)
}

func (a *PionCaptureAttempt) Run(ctx context.Context) error {
	if a == nil || a.peer == nil || a.coordinator == nil || a.plans == nil || a.keys == nil || a.objects == nil || a.bundles == nil || a.lifecycle == nil {
		return ErrInvalidCaptureAttempt
	}
	if ctx == nil {
		ctx = context.Background()
	}
	a.mu.Lock()
	if a.running || a.closing || a.closed {
		a.mu.Unlock()
		return ErrInvalidCaptureAttempt
	}
	a.running = true
	a.mu.Unlock()

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	plan, err := a.initialPlan(runCtx)
	if err != nil {
		return a.finishFailure(err, nil)
	}
	snapshot, err := a.coordinator.Bootstrap(runCtx, plan)
	if err != nil {
		return a.finishFailure(err, nil)
	}
	a.mu.Lock()
	a.bootstrapped = true
	a.mu.Unlock()

	writer := newCaptureBundleWriter(a)
	if plan.StopState() != captureplan.StopStateRunning {
		return a.finishSuccess(runCtx, writer, plan)
	}
	planEvents := make(chan capturePlanEvent, 1)
	readers := make(map[string]CaptureMediaTrack)
	if len(snapshot.Tracks) == 0 {
		// Empty initial plans have no blocking track bind to supervise. Establish
		// the recording origin before polling can advance no-RTP checkpoints.
		readyAt := a.config.Now().UTC()
		if err := a.emitReadyAt(runCtx, true, readyAt); err != nil {
			return a.finishFailure(err, writer)
		}
		writer.setOrigin(readyAt)
	}
	go a.planLoop(runCtx, planEvents)
	if len(snapshot.Tracks) > 0 {
		var stopped bool
		readers, plan, stopped, err = a.bindTracksWhileWatchingPlans(runCtx, writer, plan, snapshot, planEvents, nil, nil)
		if err != nil {
			return a.finishFailure(err, writer)
		}
		if stopped {
			cancel()
			return a.finishSuccess(runCtx, writer, plan)
		}
	}
	if len(readers) == 0 && len(snapshot.Tracks) > 0 {
		readyAt := a.config.Now().UTC()
		if err := a.emitReadyAt(runCtx, true, readyAt); err != nil {
			return a.finishFailure(err, writer)
		}
		writer.setOrigin(readyAt)
	}
	if err := writer.reconcileTracks(runCtx, plan, readers, a.config.Now()); err != nil {
		return a.finishFailure(err, writer)
	}

	events := make(chan captureRuntimeEvent, 256)
	readerCancels, readerCancel, startErr := startCaptureReaders(runCtx, a.peer, readers, a.config.RTPReadDeadline, events)
	if startErr != nil {
		return a.finishFailure(startErr, writer)
	}
	defer readerCancel()

	for {
		select {
		case <-runCtx.Done():
			return a.finishFailure(runCtx.Err(), writer)
		case event := <-events:
			if !captureRuntimeEventMatchesReaders(event, readers) {
				continue
			}
			if event.err != nil {
				if gapErr := writer.addTerminalGap(a.config.Now()); gapErr != nil {
					event.err = errors.Join(event.err, gapErr)
				}
				cancel()
				return a.finishFailure(event.err, writer)
			}
			if err := a.consumePacket(runCtx, writer, event); err != nil {
				cancel()
				return a.finishFailure(err, writer)
			}
		case event := <-planEvents:
			if event.checkpointNoRTP {
				if len(readers) == 0 {
					if err := writer.checkpointNoRTP(runCtx, event.at); err != nil {
						cancel()
						return a.finishFailure(err, writer)
					}
				}
				continue
			}
			if event.err != nil {
				if errors.Is(event.err, captureplan.ErrNoChange) || errors.Is(event.err, ErrNoChange) || errors.Is(event.err, captureplan.ErrWaitTimeout) {
					continue
				}
				cancel()
				return a.finishFailure(event.err, writer)
			}
			snapshot, err := a.coordinator.Reconcile(runCtx, event.plan)
			if err != nil {
				cancel()
				return a.finishFailure(err, writer)
			}
			if event.plan.StopState() != captureplan.StopStateRunning {
				cancel()
				return a.finishSuccess(runCtx, writer, event.plan)
			}
			updatedReaders, appliedPlan, stopped, err := a.bindTracksWhileWatchingPlans(runCtx, writer, event.plan, snapshot, planEvents, events, readers)
			if err != nil {
				cancel()
				return a.finishFailure(err, writer)
			}
			if stopped {
				cancel()
				return a.finishSuccess(runCtx, writer, appliedPlan)
			}
			if err := a.applyBoundTracks(runCtx, writer, appliedPlan, updatedReaders, readers, readerCancels, events); err != nil {
				cancel()
				return a.finishFailure(err, writer)
			}
			readers = updatedReaders
		}
	}
}

func (a *PionCaptureAttempt) initialPlan(ctx context.Context) (captureplan.Plan, error) {
	a.mu.Lock()
	lease := a.lease
	a.mu.Unlock()
	authority := captureplan.PlanAuthority{
		PlanHandle: a.authority.PlanHandle, TenantID: a.authority.TenantID, SpaceID: a.authority.SpaceID,
		EpisodeID: a.authority.EpisodeID, RecordingID: a.authority.RecordingID, JobID: a.authority.JobID,
		AttemptCount: a.authority.AttemptCount, FencingGeneration: a.authority.FencingGeneration,
		CaptureEpoch: a.authority.CaptureEpoch, EnvelopeDigest: a.authority.EnvelopeDigest,
	}
	input := captureplan.NewWaitInput(authority, captureplan.WorkerLease{Owner: lease.Owner, Token: lease.Token, ExpiresAt: lease.ExpiresAt}, 0, a.config.InitialPlanWait)
	return a.plans.WaitForPlan(ctx, input)
}

func (a *PionCaptureAttempt) planLoop(ctx context.Context, output chan<- capturePlanEvent) {
	snapshot, err := a.coordinator.Snapshot()
	if err != nil {
		sendCapturePlanEvent(ctx, output, capturePlanEvent{err: err})
		return
	}
	afterRevision := snapshot.PlanRevision
	for {
		if err := ctx.Err(); err != nil {
			return
		}
		a.mu.Lock()
		lease := a.lease
		a.mu.Unlock()
		authority := captureplan.PlanAuthority{
			PlanHandle: a.authority.PlanHandle, TenantID: a.authority.TenantID, SpaceID: a.authority.SpaceID,
			EpisodeID: a.authority.EpisodeID, RecordingID: a.authority.RecordingID, JobID: a.authority.JobID,
			AttemptCount: a.authority.AttemptCount, FencingGeneration: a.authority.FencingGeneration,
			CaptureEpoch: a.authority.CaptureEpoch, EnvelopeDigest: a.authority.EnvelopeDigest,
		}
		input := captureplan.NewWaitInput(authority, captureplan.WorkerLease{Owner: lease.Owner, Token: lease.Token, ExpiresAt: lease.ExpiresAt}, afterRevision, a.config.PlanWait)
		plan, err := a.plans.WaitForPlan(ctx, input)
		if err != nil {
			if errors.Is(err, ErrNoChange) || errors.Is(err, captureplan.ErrNoChange) || errors.Is(err, captureplan.ErrWaitTimeout) {
				if sendCapturePlanEvent(ctx, output, capturePlanEvent{checkpointNoRTP: true, at: a.config.Now().UTC()}) != nil {
					return
				}
				continue
			}
			if sendCapturePlanEvent(ctx, output, capturePlanEvent{err: err}) != nil {
				return
			}
			return
		}
		// The packet consumer applies each plan before the next one can retire
		// its tracks. Polling must not mutate the peer ahead of that consumer.
		if sendCapturePlanEvent(ctx, output, capturePlanEvent{plan: plan}) != nil {
			return
		}
		afterRevision = plan.Revision()
	}
}

type capturePlanEvent struct {
	plan            captureplan.Plan
	err             error
	checkpointNoRTP bool
	at              time.Time
}

func sendCapturePlanEvent(ctx context.Context, output chan<- capturePlanEvent, event capturePlanEvent) error {
	select {
	case output <- event:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (a *PionCaptureAttempt) bindTracks(ctx context.Context, tracks []captureplane.PulledCaptureTrack) (map[string]CaptureMediaTrack, error) {
	ordered := append([]captureplane.PulledCaptureTrack(nil), tracks...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].MID < ordered[j].MID })
	bound := make(map[string]CaptureMediaTrack, len(ordered))
	for _, expected := range ordered {
		track, err := a.peer.WaitForTrack(ctx, expected.MID)
		if err != nil {
			return nil, fmt.Errorf("wait for capture MID %s: %w", expected.MID, err)
		}
		if track == nil || track.MID() != expected.MID {
			return nil, fmt.Errorf("%w: expected MID %s", ErrInvalidCaptureAttempt, expected.MID)
		}
		identity := track.CaptureTrack()
		if identity.MID != expected.MID || identity.TrackReference != expected.TrackReference || identity.OwnerReference != expected.OwnerReference {
			return nil, fmt.Errorf("%w: capture MID %s identity changed", ErrInvalidCaptureAttempt, expected.MID)
		}
		if err := validateCaptureCodec(expected.Kind, track.Codec()); err != nil {
			return nil, fmt.Errorf("capture MID %s: %w", expected.MID, err)
		}
		if expected.Kind == captureplane.TrackKindVideo {
			if err := a.peer.RequestKeyFrame(expected.MID); err != nil {
				return nil, fmt.Errorf("request keyframe for capture MID %s: %w", expected.MID, err)
			}
		}
		bound[string(expected.MID)] = track
	}
	return bound, nil
}

type captureTrackBindResult struct {
	tracks map[string]CaptureMediaTrack
	err    error
}

func (a *PionCaptureAttempt) bindTracksWhileWatchingPlans(ctx context.Context, writer *captureBundleWriter, plan captureplan.Plan, snapshot recordercapture.Snapshot, planEvents <-chan capturePlanEvent, runtimeEvents <-chan captureRuntimeEvent, currentReaders map[string]CaptureMediaTrack) (map[string]CaptureMediaTrack, captureplan.Plan, bool, error) {
bindPlan:
	for {
		bindCtx, cancelBind := context.WithTimeout(ctx, a.config.InitialPlanWait)
		result := make(chan captureTrackBindResult, 1)
		expected := append([]captureplane.PulledCaptureTrack(nil), snapshot.Tracks...)
		go func() {
			tracks, err := a.bindTracks(bindCtx, expected)
			result <- captureTrackBindResult{tracks: tracks, err: err}
		}()

		for {
			select {
			case <-ctx.Done():
				cancelBind()
				<-result
				return nil, captureplan.Plan{}, false, ctx.Err()
			case bound := <-result:
				cancelBind()
				return bound.tracks, plan, false, bound.err
			case event := <-runtimeEvents:
				if !captureRuntimeEventMatchesPlannedReaders(event, currentReaders, snapshot.Tracks) {
					continue
				}
				if event.err != nil {
					cancelBind()
					<-result
					if gapErr := writer.addTerminalGap(a.config.Now()); gapErr != nil {
						event.err = errors.Join(event.err, gapErr)
					}
					return nil, captureplan.Plan{}, false, event.err
				}
				if err := a.consumePacket(ctx, writer, event); err != nil {
					cancelBind()
					<-result
					return nil, captureplan.Plan{}, false, err
				}
			case event := <-planEvents:
				if event.checkpointNoRTP {
					if !hasPlannedCaptureReader(currentReaders, snapshot.Tracks) {
						if err := writer.checkpointNoRTP(ctx, event.at); err == nil {
							continue
						} else {
							cancelBind()
							<-result
							return nil, captureplan.Plan{}, false, err
						}
					}
					continue
				}
				cancelBind()
				<-result
				if event.err != nil {
					return nil, captureplan.Plan{}, false, event.err
				}
				latest, err := a.coordinator.Reconcile(ctx, event.plan)
				if err != nil {
					return nil, captureplan.Plan{}, false, err
				}
				plan = event.plan
				snapshot = latest
				if plan.StopState() != captureplan.StopStateRunning {
					return nil, plan, true, nil
				}
				continue bindPlan
			}
		}
	}
}

func captureRuntimeEventMatchesReaders(event captureRuntimeEvent, readers map[string]CaptureMediaTrack) bool {
	current, ok := readers[event.mid]
	return ok && event.track != nil && sameCaptureBinding(current, event.track)
}

func captureRuntimeEventMatchesPlannedReaders(event captureRuntimeEvent, readers map[string]CaptureMediaTrack, expected []captureplane.PulledCaptureTrack) bool {
	if !captureRuntimeEventMatchesReaders(event, readers) {
		return false
	}
	for _, track := range expected {
		if track.MID.String() == event.mid && track == event.track.CaptureTrack() {
			return true
		}
	}
	return false
}

func hasPlannedCaptureReader(readers map[string]CaptureMediaTrack, expected []captureplane.PulledCaptureTrack) bool {
	for _, track := range expected {
		current, ok := readers[track.MID.String()]
		if ok && current != nil && track == current.CaptureTrack() {
			return true
		}
	}
	return false
}

func (a *PionCaptureAttempt) applyBoundTracks(ctx context.Context, writer *captureBundleWriter, plan captureplan.Plan, next, previous map[string]CaptureMediaTrack, readerCancels map[string]func(), events chan<- captureRuntimeEvent) error {
	if err := writer.reconcileTracks(ctx, plan, next, a.config.Now()); err != nil {
		return err
	}
	for mid, previousTrack := range previous {
		nextTrack, ok := next[mid]
		if !ok || !sameCaptureBinding(previousTrack, nextTrack) {
			if cancel := readerCancels[mid]; cancel != nil {
				cancel()
			}
			delete(readerCancels, mid)
		}
	}
	for mid, track := range next {
		if previousTrack, ok := previous[mid]; ok && sameCaptureBinding(previousTrack, track) {
			continue
		}
		cancel, err := startCaptureReader(ctx, a.peer, mid, track, a.config.RTPReadDeadline, events)
		if err != nil {
			return err
		}
		readerCancels[mid] = cancel
	}
	return nil
}

func (a *PionCaptureAttempt) consumePacket(ctx context.Context, writer *captureBundleWriter, event captureRuntimeEvent) error {
	if event.packet == nil || event.track == nil {
		return fmt.Errorf("%w: empty RTP event", ErrInvalidCaptureAttempt)
	}
	if !a.ready {
		if err := a.emitReadyAt(ctx, false, event.at); err != nil {
			return err
		}
		writer.setOrigin(event.at)
	}
	return writer.addPacket(ctx, event.track, event.packet, event.at)
}

func (a *PionCaptureAttempt) emitReady(ctx context.Context, noPublisher bool) error {
	return a.emitReadyAt(ctx, noPublisher, a.config.Now().UTC())
}

func (a *PionCaptureAttempt) emitReadyAt(ctx context.Context, noPublisher bool, readyAt time.Time) error {
	a.mu.Lock()
	if a.ready {
		a.mu.Unlock()
		return nil
	}
	key := captureLifecycleKey("ready", a.authority.RecordingID.String(), uint64(a.authority.CaptureEpoch))
	event := CaptureReadyEvent{
		TenantID: a.authority.TenantID.String(), SpaceID: a.authority.SpaceID.String(), EpisodeID: a.authority.EpisodeID.String(), RecordingID: a.authority.RecordingID.String(), JobID: a.authority.JobID.String(),
		CaptureEpoch: uint64(a.authority.CaptureEpoch), Attempt: a.authority.AttemptCount, FencingGeneration: a.authority.FencingGeneration,
		EnvelopeDigest: hex.EncodeToString(a.authority.EnvelopeDigest), LeaseOwner: a.lease.Owner, LeaseToken: a.lease.Token, LeaseExpiresAt: a.lease.ExpiresAt,
		At: readyAt.UTC(), IdempotencyKey: key, NoPublisher: noPublisher,
	}
	a.mu.Unlock()
	if err := a.lifecycle.Ready(ctx, event); err != nil {
		return fmt.Errorf("emit capture ready: %w", err)
	}
	a.mu.Lock()
	a.ready = true
	a.readyEvent = event
	a.mu.Unlock()
	return nil
}

func validateCaptureCodec(kind captureplane.TrackKind, codec string) error {
	codec = strings.ToLower(strings.TrimSpace(codec))
	if kind == captureplane.TrackKindAudio && codec == "opus" {
		return nil
	}
	if kind == captureplane.TrackKindVideo && (codec == "vp8" || codec == "h264") {
		return nil
	}
	return fmt.Errorf("%w: unsupported %s codec %q", ErrInvalidCaptureAttempt, kind, codec)
}

func sameCaptureBinding(left, right CaptureMediaTrack) bool {
	if left == nil || right == nil || left.Codec() != right.Codec() || left.RID() != right.RID() {
		return false
	}
	return left.CaptureTrack() == right.CaptureTrack()
}

func (a *PionCaptureAttempt) finishSuccess(ctx context.Context, writer *captureBundleWriter, plan captureplan.Plan) error {
	// A planned stop is terminal for this capture epoch. Active publishers may
	// still have tracks when an Episode ends, and the provider contract requires
	// force for that close. Cleanup uses the same value so a retry preserves the
	// durable signaling command fingerprint.
	closeCtx, cancel := context.WithTimeout(context.Background(), a.config.CloseTimeout)
	result := a.closeLocal(closeCtx, writer, recordingbundle.CloseReasonFinalStop)
	cancel()
	if result != nil {
		return result
	}
	stopID := captureLifecycleKey("stopped", a.authority.RecordingID.String(), uint64(a.authority.CaptureEpoch))
	lease := a.currentLease()
	stop := CaptureStoppedEvent{
		TenantID: a.authority.TenantID.String(), SpaceID: a.authority.SpaceID.String(), EpisodeID: a.authority.EpisodeID.String(), RecordingID: a.authority.RecordingID.String(), JobID: a.authority.JobID.String(),
		CaptureEpoch: uint64(a.authority.CaptureEpoch), Attempt: a.authority.AttemptCount, FencingGeneration: a.authority.FencingGeneration,
		EnvelopeDigest: hex.EncodeToString(a.authority.EnvelopeDigest), LeaseOwner: lease.Owner, LeaseToken: lease.Token, LeaseExpiresAt: lease.ExpiresAt,
		At: a.config.Now().UTC(), IdempotencyKey: stopID,
	}
	callbackCtx, callbackCancel := context.WithTimeout(context.Background(), a.config.CloseTimeout)
	err := a.lifecycle.Stopped(callbackCtx, stop)
	callbackCancel()
	if err != nil {
		return fmt.Errorf("emit capture stopped: %w", err)
	}
	return nil
}

func (a *PionCaptureAttempt) finishFailure(cause error, writer *captureBundleWriter) error {
	closeCtx, cancel := context.WithTimeout(context.Background(), a.config.CloseTimeout)
	closeErr := a.closeLocal(closeCtx, writer, recordingbundle.CloseReasonExplicit)
	cancel()
	return errors.Join(cause, closeErr)
}

func (a *PionCaptureAttempt) closeLocal(ctx context.Context, writer *captureBundleWriter, reason recordingbundle.CloseReason) error {
	a.mu.Lock()
	if a.closing || a.closed {
		done := a.closeDone
		a.mu.Unlock()
		select {
		case <-done:
			a.mu.Lock()
			defer a.mu.Unlock()
			return a.closeErr
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	a.closing = true
	a.closeDone = make(chan struct{})
	bootstrapped := a.bootstrapped
	a.mu.Unlock()

	var result error
	// Stop remote ingress before the bounded durable tail. A storage timeout must
	// fail the attempt, but it must not consume the provider shutdown budget first.
	if bootstrapped {
		result = a.coordinator.Close(ctx, true)
	}
	result = errors.Join(result, a.peer.Close())
	if writer != nil {
		result = errors.Join(result, writer.closeWithContext(ctx, reason, a.config.Now()))
	}
	result = errors.Join(result, ctx.Err())
	a.mu.Lock()
	a.closeErr = result
	a.closing = false
	a.closed = true
	close(a.closeDone)
	a.mu.Unlock()
	return result
}

func captureLifecycleKey(kind, recording string, epoch uint64) string {
	raw := fmt.Sprintf("capture_%s_%s_%d", kind, recording, epoch)
	if len(raw) <= captureplane.MaxIdempotencyKeyBytes {
		return raw
	}
	digest := sha256.Sum256([]byte(raw))
	return fmt.Sprintf("capture_%s_%s", kind, hex.EncodeToString(digest[:]))
}

type captureRuntimeEvent struct {
	mid    string
	track  CaptureMediaTrack
	packet *rtp.Packet
	at     time.Time
	err    error
}

func startCaptureReaders(ctx context.Context, peer CapturePeer, tracks map[string]CaptureMediaTrack, deadline time.Duration, events chan<- captureRuntimeEvent) (map[string]func(), func(), error) {
	if len(tracks) == 0 {
		return make(map[string]func()), func() {}, nil
	}
	readerCtx, cancel := context.WithCancel(ctx)
	cancels := make(map[string]func(), len(tracks))
	for mid, track := range tracks {
		readerCancel, err := startCaptureReader(readerCtx, peer, mid, track, deadline, events)
		if err != nil {
			cancel()
			for _, stop := range cancels {
				stop()
			}
			return nil, nil, err
		}
		cancels[mid] = readerCancel
	}
	return cancels, func() {
		cancel()
		for _, stop := range cancels {
			stop()
		}
	}, nil
}

func startCaptureReader(ctx context.Context, peer CapturePeer, mid string, track CaptureMediaTrack, deadline time.Duration, events chan<- captureRuntimeEvent) (func(), error) {
	if peer == nil || track == nil || strings.TrimSpace(mid) == "" || deadline <= 0 {
		return nil, ErrInvalidCaptureAttempt
	}
	readerCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	video := track.CaptureTrack().Kind == captureplane.TrackKindVideo
	go func() {
		defer close(done)
		defer cancel()
		var lossFeedback captureVideoLossFeedback
		for {
			if err := readerCtx.Err(); err != nil {
				return
			}
			if err := track.SetReadDeadline(time.Now().Add(deadline)); err != nil {
				sendCaptureRuntimeEvent(readerCtx, events, captureRuntimeEvent{mid: mid, track: track, err: err})
				return
			}
			packet, _, err := track.ReadRTP()
			if err != nil {
				if isCaptureReadTimeout(err) {
					if peerErr := peer.Error(); peerErr != nil {
						sendCaptureRuntimeEvent(readerCtx, events, captureRuntimeEvent{mid: mid, track: track, err: errors.Join(ErrCapturePeerTerminal, peerErr)})
						return
					}
					continue
				}
				sendCaptureRuntimeEvent(readerCtx, events, captureRuntimeEvent{mid: mid, track: track, err: err})
				return
			}
			if packet == nil {
				sendCaptureRuntimeEvent(readerCtx, events, captureRuntimeEvent{mid: mid, track: track, err: errors.New("capture RTP reader returned nil packet")})
				return
			}
			receivedAt := time.Now()
			if video && lossFeedback.Observe(packet.SSRC, packet.SequenceNumber, receivedAt) {
				if err := peer.RequestKeyFrame(captureplane.ProviderReference(mid)); err != nil {
					sendCaptureRuntimeEvent(readerCtx, events, captureRuntimeEvent{mid: mid, track: track, err: fmt.Errorf("request keyframe after RTP loss for capture MID %s: %w", mid, err)})
					return
				}
			}
			if err := sendCaptureRuntimeEvent(readerCtx, events, captureRuntimeEvent{mid: mid, track: track, packet: packet, at: receivedAt.UTC()}); err != nil {
				return
			}
		}
	}()
	return func() {
		cancel()
		<-done
	}, nil
}

type captureVideoLossFeedback struct {
	sequence         rtpSequenceExtender
	ssrc             uint32
	initialized      bool
	next             uint64
	highest          uint64
	received         map[uint64]struct{}
	lastKeyFrameTime time.Time
	pending          bool
}

func (f *captureVideoLossFeedback) Observe(ssrc uint32, sequence uint16, now time.Time) bool {
	if !f.initialized || f.ssrc != ssrc {
		*f = captureVideoLossFeedback{ssrc: ssrc, initialized: true}
		extended := f.sequence.Extend(sequence)
		f.next = extended + 1
		f.highest = extended
		return false
	}
	extended := f.sequence.Extend(sequence)
	if extended < f.next {
		return false
	}
	if f.received == nil {
		f.received = make(map[uint64]struct{}, captureVideoReorderWindow)
	}
	f.received[extended] = struct{}{}
	f.highest = max(f.highest, extended)
	for {
		if _, ok := f.received[f.next]; !ok {
			break
		}
		delete(f.received, f.next)
		f.next++
	}
	if f.next <= f.highest && f.highest-f.next >= captureVideoReorderWindow {
		f.next = f.highest + 1
		clear(f.received)
		f.pending = true
	}
	if !f.pending || (!f.lastKeyFrameTime.IsZero() && now.Before(f.lastKeyFrameTime.Add(captureKeyFrameRequestSpacing))) {
		return false
	}
	f.pending = false
	f.lastKeyFrameTime = now
	return true
}

func sendCaptureRuntimeEvent(ctx context.Context, events chan<- captureRuntimeEvent, event captureRuntimeEvent) error {
	select {
	case events <- event:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func isCaptureReadTimeout(err error) bool {
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

type capturePionPeer struct{ *pion.Peer }

func (p *capturePionPeer) WaitForTrack(ctx context.Context, mid captureplane.ProviderReference) (CaptureMediaTrack, error) {
	track, err := p.Peer.WaitForTrack(ctx, mid)
	if err != nil {
		return nil, err
	}
	return track, nil
}

type rtpSequenceExtender struct {
	initialized bool
	last        uint16
	highest     uint64
}

func (e *rtpSequenceExtender) Extend(sequence uint16) uint64 {
	if e == nil {
		return uint64(sequence)
	}
	if !e.initialized {
		e.initialized = true
		e.last = sequence
		e.highest = uint64(sequence)
		return e.highest
	}
	cycle := e.highest >> 16
	candidate := (cycle << 16) | uint64(sequence)
	if sequence < e.last && e.last-sequence > 0x8000 {
		candidate += 1 << 16
	}
	if sequence > e.last && sequence-e.last > 0x8000 {
		if cycle == 0 {
			return uint64(sequence)
		}
		candidate -= 1 << 16
	}
	if candidate > e.highest {
		e.highest = candidate
		e.last = sequence
	}
	return candidate
}

type captureTrackClock struct {
	sequence rtpSequenceExtender
	baseTS   uint32
	baseMS   int64
	started  bool
}

func (c *captureTrackClock) normalize(packet *rtp.Packet, kind captureplane.TrackKind, firstPacketMS int64) (int64, uint32) {
	rate := captureClockRate(kind)
	if !c.started {
		c.started = true
		c.baseTS = packet.Timestamp
		c.baseMS = firstPacketMS
		return c.baseMS, uint32(c.baseMS * rate / 1_000)
	}
	delta := int64(int32(packet.Timestamp - c.baseTS))
	if delta < 0 {
		delta = 0
	}
	media := c.baseMS + delta*1_000/rate
	timestamp := uint32(c.baseMS*rate/1_000) + uint32(delta)
	return media, timestamp
}

func captureClockRate(kind captureplane.TrackKind) int64 {
	if kind == captureplane.TrackKindAudio {
		return 48_000
	}
	return 90_000
}

// captureBundleWriter is the runtime's bounded handoff from RTP to the
// canonical assembler, encryption, upload, and API commit ports.
type captureBundleWriter struct {
	attempt        *PionCaptureAttempt
	key            []byte
	contextDigest  []byte
	assembler      *recordingbundle.Assembler
	reservation    BundleReservation
	reserveOrdinal uint64
	origin         time.Time
	pendingGaps    []recordingbundle.Gap
	active         map[string]recordingbundle.TrackIdentity
	bindings       map[string]captureplane.PulledCaptureTrack
	layout         recordingbundle.LayoutTimelineEvent
	hasLayout      bool
	clocks         map[string]*captureTrackClock
	lastMono       int64
	lastMedia      int64
	terminalGap    bool
}

func newCaptureBundleWriter(attempt *PionCaptureAttempt) *captureBundleWriter {
	writer := &captureBundleWriter{attempt: attempt, active: make(map[string]recordingbundle.TrackIdentity), bindings: make(map[string]captureplane.PulledCaptureTrack), clocks: make(map[string]*captureTrackClock)}
	if attempt.authority.CaptureReadyAt != nil {
		writer.origin = attempt.authority.CaptureReadyAt.UTC()
		// A replacement epoch has no authoritative prior bundle end in its
		// envelope. Start its no-RTP bookkeeping at the local recovery boundary;
		// the decoder represents the interval from the prior epoch as recovery.
		recoveryStart := writer.relative(attempt.config.Now().UTC())
		writer.lastMono = recoveryStart
		writer.lastMedia = recoveryStart
	}
	return writer
}

func (w *captureBundleWriter) setOrigin(origin time.Time) {
	if w.origin.IsZero() {
		w.origin = origin.UTC()
	}
}

func (w *captureBundleWriter) setLayout(ctx context.Context, plan captureplan.Plan, now time.Time) error {
	kind := recordingbundle.LayoutEventSnapshot
	if w.hasLayout && w.layout.Layout != string(plan.LayoutProfile()) {
		kind = recordingbundle.LayoutEventChanged
	}
	mono, media := w.controlEventClocks(now)
	layout := recordingbundle.LayoutTimelineEvent{MonotonicMilliseconds: mono, MediaMilliseconds: media, Kind: kind, Revision: uint64(plan.Revision()), Layout: string(plan.LayoutProfile())}
	if w.assembler != nil {
		if err := w.appendControlEvent(ctx, mono, media, func(assembler *recordingbundle.Assembler) error {
			return assembler.AddLayoutEvent(layout)
		}); err != nil {
			return err
		}
		w.layout = layout
		w.hasLayout = true
		return nil
	}
	w.layout = layout
	w.hasLayout = true
	return nil
}

func (w *captureBundleWriter) controlEventClocks(now time.Time) (int64, int64) {
	relative := w.relative(now)
	return max(relative, w.lastMono), max(relative, w.lastMedia)
}

func (w *captureBundleWriter) advanceClocks(monotonic, media int64) {
	w.lastMono = max(w.lastMono, monotonic)
	w.lastMedia = max(w.lastMedia, media)
}

func (w *captureBundleWriter) appendControlEvent(ctx context.Context, monotonic, media int64, appendEvent func(*recordingbundle.Assembler) error) error {
	err := appendEvent(w.assembler)
	if errors.Is(err, recordingbundle.ErrDurationLimit) {
		if err := w.closeCurrentBundle(ctx, recordingbundle.CloseReasonExplicit); err != nil {
			return err
		}
		if err := w.appendGapUntil(ctx, monotonic, media, false); err != nil {
			return err
		}
		err = appendEvent(w.assembler)
	}
	if err != nil {
		return err
	}
	w.advanceClocks(monotonic, media)
	if w.assembler.Closed() {
		return w.persist(ctx)
	}
	return nil
}

func (w *captureBundleWriter) closeCurrentBundle(ctx context.Context, reason recordingbundle.CloseReason) error {
	if w.assembler == nil {
		return nil
	}
	if !w.assembler.Closed() {
		if err := w.assembler.Close(reason, w.lastMono, w.lastMedia); err != nil {
			return err
		}
	}
	return w.persist(ctx)
}

func (w *captureBundleWriter) checkpointNoRTP(ctx context.Context, now time.Time) error {
	if w.origin.IsZero() || w.terminalGap || len(w.active) > 0 {
		return nil
	}
	targetMono, targetMedia := w.controlEventClocks(now)
	const maximumGapDuration = recordingbundle.TargetBundleDurationMilliseconds - 1
	for targetMono-w.lastMono >= maximumGapDuration || targetMedia-w.lastMedia >= maximumGapDuration {
		if err := w.closeCurrentBundle(ctx, recordingbundle.CloseReasonExplicit); err != nil {
			return err
		}
		endMono := min(targetMono, w.lastMono+maximumGapDuration)
		endMedia := min(targetMedia, w.lastMedia+maximumGapDuration)
		if err := w.appendGapUntil(ctx, endMono, endMedia, false); err != nil {
			return err
		}
		if err := w.closeCurrentBundle(ctx, recordingbundle.CloseReasonExplicit); err != nil {
			return err
		}
	}
	return nil
}

func (w *captureBundleWriter) appendGapUntil(ctx context.Context, endMono, endMedia int64, terminal bool) error {
	// Bundle-start track and layout snapshots are appended after the pending gap.
	// Stay below cadence so those snapshots cannot close the assembler before
	// every active state snapshot has been rebased onto the gap endpoint.
	const maximumGapDuration = recordingbundle.TargetBundleDurationMilliseconds - 1
	if endMono < w.lastMono || endMedia < w.lastMedia {
		return fmt.Errorf("%w: gap target", recordingbundle.ErrNonMonotonicTime)
	}
	if !terminal && endMono == w.lastMono && endMedia == w.lastMedia {
		return w.ensureAssembler(ctx)
	}
	for {
		nextMono := min(endMono, w.lastMono+maximumGapDuration)
		nextMedia := min(endMedia, w.lastMedia+maximumGapDuration)
		final := nextMono == endMono && nextMedia == endMedia
		reason := "no_rtp"
		if terminal {
			reason = "terminal_read"
		}
		w.pendingGaps = append(w.pendingGaps, recordingbundle.Gap{
			StartMonotonicMilliseconds: w.lastMono,
			EndMonotonicMilliseconds:   nextMono,
			StartMediaMilliseconds:     w.lastMedia,
			EndMediaMilliseconds:       nextMedia,
			Reason:                     reason,
			Terminal:                   terminal && final,
		})
		w.advanceClocks(nextMono, nextMedia)
		if err := w.ensureAssembler(ctx); err != nil {
			return err
		}
		if final {
			return nil
		}
		if err := w.closeCurrentBundle(ctx, recordingbundle.CloseReasonExplicit); err != nil {
			return err
		}
	}
}

func (w *captureBundleWriter) relative(now time.Time) int64 {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if w.origin.IsZero() || now.Before(w.origin) {
		return 0
	}
	return now.Sub(w.origin).Milliseconds()
}

func (w *captureBundleWriter) ensureAssembler(ctx context.Context) error {
	if w.assembler != nil {
		return nil
	}
	lease := w.attempt.currentLease()
	if w.key == nil {
		dataKey, err := w.attempt.keys.AccessKey(ctx, CaptureKeyRequest{
			TenantID: w.attempt.authority.TenantID.String(), SpaceID: w.attempt.authority.SpaceID.String(), EpisodeID: w.attempt.authority.EpisodeID.String(), RecordingID: w.attempt.authority.RecordingID.String(), JobID: w.attempt.authority.JobID.String(),
			KeyHandle: w.attempt.authority.Envelope.KeyHandle, CaptureEpoch: uint64(w.attempt.authority.CaptureEpoch), Attempt: w.attempt.authority.AttemptCount, FencingGeneration: w.attempt.authority.FencingGeneration,
			LeaseOwner: lease.Owner, LeaseToken: lease.Token, LeaseExpiresAt: lease.ExpiresAt, EnvelopeDigest: hex.EncodeToString(w.attempt.authority.EnvelopeDigest),
		})
		if err != nil {
			return fmt.Errorf("access recording key: %w", err)
		}
		if len(dataKey.Plaintext) != 32 || len(dataKey.EncryptionContextDigest) != sha256.Size {
			clear(dataKey.Plaintext)
			return fmt.Errorf("%w: recording key response is invalid", ErrInvalidCaptureAttempt)
		}
		w.key = dataKey.Plaintext
		w.contextDigest = append([]byte(nil), dataKey.EncryptionContextDigest...)
	}
	reservationRequestID, err := utilities.NewID()
	if err != nil {
		return fmt.Errorf("generate recording bundle reservation request ID: %w", err)
	}
	request := BundleReserveRequest{
		TenantID: w.attempt.authority.TenantID.String(), SpaceID: w.attempt.authority.SpaceID.String(), EpisodeID: w.attempt.authority.EpisodeID.String(), RecordingID: w.attempt.authority.RecordingID.String(), JobID: w.attempt.authority.JobID.String(),
		ObjectHandle: w.attempt.authority.Envelope.ObjectHandle,
		CaptureEpoch: uint64(w.attempt.authority.CaptureEpoch), Attempt: w.attempt.authority.AttemptCount, FencingGeneration: w.attempt.authority.FencingGeneration,
		LeaseOwner: lease.Owner, LeaseToken: lease.Token, LeaseExpiresAt: lease.ExpiresAt, EnvelopeDigest: hex.EncodeToString(w.attempt.authority.EnvelopeDigest),
		ReservationRequestID: reservationRequestID.String(), EncryptionContextDigest: append([]byte(nil), w.contextDigest...),
	}
	reservation, err := w.attempt.bundles.Reserve(ctx, request)
	if err != nil {
		return fmt.Errorf("reserve recording bundle: %w", err)
	}
	if reservation.AllocationVersion <= 0 || strings.TrimSpace(reservation.ObjectKey) == "" {
		return fmt.Errorf("%w: invalid bundle reservation", ErrInvalidCaptureAttempt)
	}
	w.reservation = reservation
	w.reserveOrdinal++
	encryption := recordingbundle.EncryptionContext{Environment: w.attempt.config.Environment, TenantID: w.attempt.authority.TenantID.String(), EpisodeID: w.attempt.authority.EpisodeID.String(), RecordingID: w.attempt.authority.RecordingID.String(), JobID: w.attempt.authority.JobID.String(), BundleSchema: recordingbundle.Version}
	assembler, err := recordingbundle.NewAssembler(recordingbundle.AssemblerConfig{RecordingID: w.attempt.authority.RecordingID.String(), CaptureEpoch: uint64(w.attempt.authority.CaptureEpoch), Sequence: reservation.Sequence, RecorderEnvelopeDigest: hex.EncodeToString(w.attempt.authority.EnvelopeDigest), Encryption: encryption, AllocationVersion: reservation.AllocationVersion})
	if err != nil {
		return err
	}
	w.assembler = assembler
	if len(w.pendingGaps) > 0 {
		for _, gap := range w.pendingGaps {
			if err := w.assembler.AddGap(gap); err != nil {
				return err
			}
		}
		w.pendingGaps = nil
	}
	keys := make([]string, 0, len(w.active))
	for key := range w.active {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		identity := w.active[key]
		if err := w.assembler.AddTrackEvent(recordingbundle.TrackTimelineEvent{Kind: recordingbundle.TrackEventAdded, Track: identity, MonotonicMilliseconds: w.lastMono, MediaMilliseconds: w.lastMedia, Reason: "bundle_start"}); err != nil {
			return err
		}
	}
	if w.hasLayout {
		snapshot := w.layout
		snapshot.Kind = recordingbundle.LayoutEventSnapshot
		snapshot.MonotonicMilliseconds = w.lastMono
		snapshot.MediaMilliseconds = w.lastMedia
		if err := w.assembler.AddLayoutEvent(snapshot); err != nil {
			return err
		}
	}
	return nil
}

func (w *captureBundleWriter) addPacket(ctx context.Context, track CaptureMediaTrack, packet *rtp.Packet, at time.Time) error {
	identity := track.CaptureTrack()
	mid := string(identity.MID)
	activeBinding, active := w.bindings[mid]
	if !active || activeBinding != identity {
		// A reader cancellation may leave already-queued packets behind. They
		// belong to the prior binding and must not be relabeled as replacement
		// media that reused the same MID.
		return nil
	}
	bundleTrack := w.active[mid]
	clockKey := trackClockKey(bundleTrack)
	clock := w.clocks[clockKey]
	if clock == nil {
		clock = &captureTrackClock{}
		w.clocks[clockKey] = clock
	}
	arrivalMono := w.relative(at)
	media, normalizedTimestamp := clock.normalize(packet, identity.Kind, arrivalMono)
	mono := max(arrivalMono, w.lastMono)
	if mono > w.lastMono {
		w.lastMono = mono
	}
	if media > w.lastMedia {
		w.lastMedia = media
	}
	if err := w.ensureAssembler(ctx); err != nil {
		return err
	}
	input := recordingbundle.MediaPacket{Track: bundleTrack, Packet: recordingbundle.RTPPacket{SequenceNumber: packet.SequenceNumber, ExtendedSequenceNumber: clock.sequence.Extend(packet.SequenceNumber), Timestamp: normalizedTimestamp, SSRC: packet.SSRC, PayloadType: packet.PayloadType, Marker: packet.Marker, Payload: packet.Payload}, MonotonicMilliseconds: mono, MediaMilliseconds: media}
	err := w.assembler.AddPacket(input)
	if err == nil {
		if w.assembler.Closed() {
			return w.persist(ctx)
		}
		return nil
	}
	if !errors.Is(err, recordingbundle.ErrAssemblerClosed) && !errors.Is(err, recordingbundle.ErrDurationLimit) {
		return err
	}
	if persistErr := w.persist(ctx); persistErr != nil {
		return persistErr
	}
	return w.addPacket(ctx, track, packet, at)
}

func (w *captureBundleWriter) reconcileTracks(ctx context.Context, plan captureplan.Plan, tracks map[string]CaptureMediaTrack, now time.Time) error {
	if plan.Authority().CaptureEpoch != w.attempt.authority.CaptureEpoch {
		return fmt.Errorf("%w: capture plan epoch mismatch", ErrInvalidCaptureAttempt)
	}
	previousActive := w.active
	next := make(map[string]recordingbundle.TrackIdentity, len(tracks))
	nextBindings := make(map[string]captureplane.PulledCaptureTrack, len(tracks))
	planEpoch, err := recordingbundle.ComposeTrackEpoch(uint64(plan.Authority().CaptureEpoch), uint64(plan.Revision()))
	if err != nil {
		return fmt.Errorf("%w: compose track epoch: %v", ErrInvalidCaptureAttempt, err)
	}
	for mid, mediaTrack := range tracks {
		track := mediaTrack.CaptureTrack()
		epoch := planEpoch
		if existingBinding, ok := w.bindings[mid]; ok && existingBinding == track {
			if existing, active := w.active[mid]; active && existing.Codec == mediaTrack.Codec() {
				epoch = existing.Epoch
			}
		}
		next[mid] = recordingbundle.TrackIdentity{TrackID: track.TrackReference.String(), Epoch: epoch, MID: track.MID.String(), Codec: mediaTrack.Codec(), Layer: track.RequestedLayer.String()}
		nextBindings[mid] = track
	}
	changed := len(next) != len(w.active)
	if !changed {
		for key, value := range next {
			if w.active[key] != value {
				changed = true
				break
			}
		}
	}
	if changed && w.assembler != nil {
		eventMono, eventMedia := w.controlEventClocks(now)
		keys := make([]string, 0, len(w.active))
		for key := range w.active {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			previous, exists := w.active[key]
			current, stillActive := next[key]
			if !exists || (stillActive && previous == current) {
				continue
			}
			kind := recordingbundle.TrackEventRemoved
			if stillActive {
				kind = recordingbundle.TrackEventReplaced
			}
			event := recordingbundle.TrackTimelineEvent{Kind: kind, Track: previous, MonotonicMilliseconds: eventMono, MediaMilliseconds: eventMedia, Reason: "plan_track_set_change"}
			if err := w.appendControlEvent(ctx, eventMono, eventMedia, func(assembler *recordingbundle.Assembler) error {
				return assembler.AddTrackEvent(event)
			}); err != nil {
				return err
			}
			if w.assembler == nil {
				break
			}
		}
		if w.assembler != nil {
			if err := w.assembler.Close(recordingbundle.CloseReasonTrackSetChange, w.lastMono, w.lastMedia); err != nil && !errors.Is(err, recordingbundle.ErrEmptyBundle) {
				return err
			}
			if w.assembler.Closed() {
				if err := w.persist(ctx); err != nil {
					return err
				}
			}
		}
	}
	w.active = next
	w.bindings = nextBindings
	if changed && w.assembler != nil {
		eventMono, eventMedia := w.controlEventClocks(now)
		keys := make([]string, 0, len(w.active))
		for key := range w.active {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			if _, existed := previousActive[key]; existed {
				continue
			}
			event := recordingbundle.TrackTimelineEvent{Kind: recordingbundle.TrackEventAdded, Track: w.active[key], MonotonicMilliseconds: eventMono, MediaMilliseconds: eventMedia, Reason: "plan_track_added"}
			if err := w.appendControlEvent(ctx, eventMono, eventMedia, func(assembler *recordingbundle.Assembler) error {
				return assembler.AddTrackEvent(event)
			}); err != nil {
				return err
			}
			if w.assembler == nil {
				break
			}
		}
	}
	if changed {
		if err := w.setLayout(ctx, plan, now); err != nil {
			return err
		}
	}
	return nil
}

func trackClockKey(track recordingbundle.TrackIdentity) string {
	return fmt.Sprintf("%s\x00%d\x00%s", track.TrackID, track.Epoch, track.MID)
}

func (w *captureBundleWriter) addTerminalGap(now time.Time) error {
	storageCtx, cancel := context.WithTimeout(context.Background(), w.attempt.config.CloseTimeout)
	defer cancel()
	return w.addTerminalGapWithContext(storageCtx, now)
}

func (w *captureBundleWriter) addTerminalGapWithContext(ctx context.Context, now time.Time) error {
	if w.terminalGap || w.origin.IsZero() {
		return nil
	}
	endMono := w.relative(now)
	if endMono < w.lastMono {
		endMono = w.lastMono
	}
	endMedia := w.relative(now)
	if endMedia < w.lastMedia {
		endMedia = w.lastMedia
	}
	if endMono == 0 && endMedia == 0 && w.lastMono == 0 && w.lastMedia == 0 {
		// A capture that starts and stops within one clock millisecond still needs
		// a positive recording-relative duration for completion and replay.
		endMono, endMedia = 1, 1
	}
	if w.assembler != nil {
		if err := w.closeCurrentBundle(ctx, recordingbundle.CloseReasonExplicit); err != nil {
			return err
		}
	}
	if err := w.appendGapUntil(ctx, endMono, endMedia, true); err != nil {
		return err
	}
	w.terminalGap = true
	return nil
}

func (w *captureBundleWriter) close(reason recordingbundle.CloseReason, now time.Time) error {
	storageCtx, cancel := context.WithTimeout(context.Background(), w.attempt.config.CloseTimeout)
	defer cancel()
	return w.closeWithContext(storageCtx, reason, now)
}

func (w *captureBundleWriter) closeWithContext(ctx context.Context, reason recordingbundle.CloseReason, now time.Time) error {
	if err := w.addTerminalGapWithContext(ctx, now); err != nil {
		return err
	}
	if w.assembler != nil {
		if !w.assembler.Closed() {
			endMono, endMedia := w.controlEventClocks(now)
			if w.terminalGap {
				endMono, endMedia = w.lastMono, w.lastMedia
			}
			if err := w.assembler.Close(reason, endMono, endMedia); err != nil && !errors.Is(err, recordingbundle.ErrEmptyBundle) {
				return err
			}
		}
		if w.assembler.Closed() {
			if err := w.persist(ctx); err != nil {
				return err
			}
		}
	}
	if len(w.pendingGaps) > 0 {
		if err := w.ensureAssembler(ctx); err != nil {
			return err
		}
		endMono, endMedia := w.controlEventClocks(now)
		if w.terminalGap {
			endMono, endMedia = w.lastMono, w.lastMedia
		}
		if err := w.assembler.Close(reason, endMono, endMedia); err != nil {
			return err
		}
		if err := w.persist(ctx); err != nil {
			return err
		}
	}
	clear(w.key)
	w.key = nil
	clear(w.contextDigest)
	w.contextDigest = nil
	return nil
}

func (w *captureBundleWriter) persist(ctx context.Context) error {
	if w.assembler == nil {
		return nil
	}
	sealed, err := w.assembler.Seal()
	if err != nil {
		return err
	}
	if w.key == nil {
		return fmt.Errorf("%w: key unavailable", ErrInvalidCaptureAttempt)
	}
	bundle := sealed.Bundle
	encoded, err := recordingbundle.Encrypt(w.key, bundle)
	pending := w.assembler.TakePendingGaps()
	w.pendingGaps = append(w.pendingGaps, pending...)
	if err != nil {
		recordingbundle.ClearSealedBundle(&sealed)
		return err
	}
	checksum := recordingbundle.ObjectChecksumHex(encoded)
	contentType := captureBundleContentType
	codec, layer := captureBundleCodecAndLayer(bundle)
	authority := w.bundleAuthority()
	upload, err := w.attempt.bundles.Finalize(ctx, CaptureBundleFinalize{Authority: authority, Reservation: w.reservation, Bundle: bundle, ObjectSize: int64(len(encoded)), ObjectSHA256: checksum, ContentType: contentType, Codec: codec, Layer: layer})
	if err != nil {
		recordingbundle.ClearSealedBundle(&sealed)
		clear(encoded)
		return fmt.Errorf("finalize recording bundle: %w", err)
	}
	if upload.Reservation.ReservationID != w.reservation.ReservationID || strings.TrimSpace(upload.UploadToken) == "" {
		recordingbundle.ClearSealedBundle(&sealed)
		clear(encoded)
		return fmt.Errorf("%w: finalized bundle authority mismatch", ErrInvalidCaptureAttempt)
	}
	if err := w.attempt.objects.Upload(ctx, CaptureObjectUpload{Upload: upload, Body: encoded, ContentType: contentType, Checksum: checksum}); err != nil {
		recordingbundle.ClearSealedBundle(&sealed)
		clear(encoded)
		return fmt.Errorf("upload recording bundle: %w", err)
	}
	if err := w.attempt.bundles.Commit(ctx, CaptureBundleCommit{Authority: authority, Reservation: w.reservation, UploadToken: upload.UploadToken, Bundle: bundle, ObjectSize: int64(len(encoded)), ObjectSHA256: checksum, ContentType: contentType}); err != nil {
		recordingbundle.ClearSealedBundle(&sealed)
		clear(encoded)
		return fmt.Errorf("commit recording bundle: %w", err)
	}
	recordingbundle.ClearSealedBundle(&sealed)
	w.assembler = nil
	w.reservation = BundleReservation{}
	clear(encoded)
	return nil
}

func (w *captureBundleWriter) bundleAuthority() BundleReserveRequest {
	lease := w.attempt.currentLease()
	return BundleReserveRequest{
		TenantID:                w.attempt.authority.TenantID.String(),
		SpaceID:                 w.attempt.authority.SpaceID.String(),
		EpisodeID:               w.attempt.authority.EpisodeID.String(),
		RecordingID:             w.attempt.authority.RecordingID.String(),
		JobID:                   w.attempt.authority.JobID.String(),
		ObjectHandle:            w.attempt.authority.Envelope.ObjectHandle,
		CaptureEpoch:            uint64(w.attempt.authority.CaptureEpoch),
		Attempt:                 w.attempt.authority.AttemptCount,
		FencingGeneration:       w.attempt.authority.FencingGeneration,
		LeaseOwner:              lease.Owner,
		LeaseToken:              lease.Token,
		LeaseExpiresAt:          lease.ExpiresAt,
		EnvelopeDigest:          hex.EncodeToString(w.attempt.authority.EnvelopeDigest),
		EncryptionContextDigest: append([]byte(nil), w.contextDigest...),
	}
}

func captureBundleCodecAndLayer(bundle recordingbundle.Bundle) (string, *string) {
	codecs := make(map[string]struct{})
	layers := make(map[string]struct{})
	for _, fragment := range bundle.Fragments {
		codecs[fragment.Track.Codec] = struct{}{}
		layers[fragment.Track.Layer] = struct{}{}
	}
	codecValues := make([]string, 0, len(codecs))
	for codec := range codecs {
		codecValues = append(codecValues, codec)
	}
	sort.Strings(codecValues)
	codec := "gap"
	if len(codecValues) > 0 {
		codec = strings.Join(codecValues, "+")
	}
	if len(layers) != 1 {
		return codec, nil
	}
	for layer := range layers {
		value := layer
		return codec, &value
	}
	return codec, nil
}

func (a *PionCaptureAttempt) currentLease() capturesignaling.WorkerLease {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.lease
}
