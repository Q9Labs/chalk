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
	defaultCaptureCloseTimeout    = 5 * time.Second
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
	return &PionCaptureAttempt{
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
	}, nil
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
	closed       bool
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

func (a *PionCaptureAttempt) Close() error {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return nil
	}
	a.closed = true
	bootstrapped := a.bootstrapped
	a.mu.Unlock()
	var closeErr error
	if bootstrapped {
		closeCtx, cancel := context.WithTimeout(context.Background(), a.config.CloseTimeout)
		closeErr = a.coordinator.Close(closeCtx, true)
		cancel()
	}
	return errors.Join(closeErr, a.peer.Close())
}

func (a *PionCaptureAttempt) Run(ctx context.Context) error {
	if a == nil || a.peer == nil || a.coordinator == nil || a.plans == nil || a.keys == nil || a.objects == nil || a.bundles == nil || a.lifecycle == nil {
		return ErrInvalidCaptureAttempt
	}
	if ctx == nil {
		ctx = context.Background()
	}
	a.mu.Lock()
	if a.running || a.closed {
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
	if len(snapshot.Tracks) == 0 {
		if err := a.emitReady(runCtx, true); err != nil {
			return a.finishFailure(err, writer)
		}
	}
	readers, err := a.bindTracks(runCtx, snapshot.Tracks)
	if err != nil {
		return a.finishFailure(err, writer)
	}
	for _, track := range readers {
		writer.setTrack(track)
	}
	if len(readers) > 0 {
		if err := writer.setLayout(runCtx, plan, a.config.Now()); err != nil {
			return a.finishFailure(err, writer)
		}
	}

	events := make(chan captureRuntimeEvent, 256)
	readerCancels, readerCancel, startErr := startCaptureReaders(runCtx, a.peer, readers, a.config.RTPReadDeadline, events)
	if startErr != nil {
		return a.finishFailure(startErr, writer)
	}
	defer readerCancel()
	planEvents := make(chan capturePlanEvent, 1)
	go a.planLoop(runCtx, planEvents)

	for {
		select {
		case <-runCtx.Done():
			return a.finishFailure(runCtx.Err(), writer)
		case event := <-events:
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
			if event.err != nil {
				if errors.Is(event.err, captureplan.ErrNoChange) || errors.Is(event.err, ErrNoChange) || errors.Is(event.err, captureplan.ErrWaitTimeout) {
					continue
				}
				cancel()
				return a.finishFailure(event.err, writer)
			}
			updatedReaders, err := a.applyPlan(runCtx, writer, event.plan, event.snapshot, readers, readerCancels, events)
			if err != nil {
				cancel()
				return a.finishFailure(err, writer)
			}
			readers = updatedReaders
			if event.plan.StopState() != captureplan.StopStateRunning {
				cancel()
				return a.finishSuccess(runCtx, writer, event.plan)
			}
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
	for {
		if err := ctx.Err(); err != nil {
			return
		}
		a.mu.Lock()
		lease := a.lease
		a.mu.Unlock()
		snapshot, err := a.coordinator.Snapshot()
		if err != nil {
			if sendCapturePlanEvent(ctx, output, capturePlanEvent{err: err}) != nil {
				return
			}
			return
		}
		authority := captureplan.PlanAuthority{
			PlanHandle: a.authority.PlanHandle, TenantID: a.authority.TenantID, SpaceID: a.authority.SpaceID,
			EpisodeID: a.authority.EpisodeID, RecordingID: a.authority.RecordingID, JobID: a.authority.JobID,
			AttemptCount: a.authority.AttemptCount, FencingGeneration: a.authority.FencingGeneration,
			CaptureEpoch: a.authority.CaptureEpoch, EnvelopeDigest: a.authority.EnvelopeDigest,
		}
		input := captureplan.NewWaitInput(authority, captureplan.WorkerLease{Owner: lease.Owner, Token: lease.Token, ExpiresAt: lease.ExpiresAt}, snapshot.PlanRevision, a.config.PlanWait)
		plan, err := a.plans.WaitForPlan(ctx, input)
		if err != nil {
			if errors.Is(err, ErrNoChange) || errors.Is(err, captureplan.ErrNoChange) || errors.Is(err, captureplan.ErrWaitTimeout) {
				continue
			}
			if sendCapturePlanEvent(ctx, output, capturePlanEvent{err: err}) != nil {
				return
			}
			return
		}
		updated, err := a.coordinator.Reconcile(ctx, plan)
		if err != nil {
			if sendCapturePlanEvent(ctx, output, capturePlanEvent{err: err}) != nil {
				return
			}
			return
		}
		if sendCapturePlanEvent(ctx, output, capturePlanEvent{plan: plan, snapshot: updated}) != nil {
			return
		}
	}
}

type capturePlanEvent struct {
	plan     captureplan.Plan
	snapshot recordercapture.Snapshot
	err      error
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
		bound[string(expected.MID)] = track
	}
	return bound, nil
}

func (a *PionCaptureAttempt) applyPlan(ctx context.Context, writer *captureBundleWriter, plan captureplan.Plan, snapshot recordercapture.Snapshot, previous map[string]CaptureMediaTrack, readerCancels map[string]func(), events chan<- captureRuntimeEvent) (map[string]CaptureMediaTrack, error) {
	next, err := a.bindTracks(ctx, snapshot.Tracks)
	if err != nil {
		return nil, err
	}
	if err := writer.reconcileTracks(ctx, plan, snapshot.Tracks, a.config.Now()); err != nil {
		return nil, err
	}
	for _, track := range next {
		writer.setTrack(track)
	}
	for mid := range previous {
		if _, ok := next[mid]; !ok {
			if cancel := readerCancels[mid]; cancel != nil {
				cancel()
			}
		}
	}
	for mid, track := range next {
		if _, ok := previous[mid]; ok {
			continue
		}
		cancel, err := startCaptureReader(ctx, a.peer, mid, track, a.config.RTPReadDeadline, events)
		if err != nil {
			return nil, err
		}
		readerCancels[mid] = cancel
	}
	for mid := range previous {
		if _, ok := next[mid]; !ok {
			delete(readerCancels, mid)
		}
	}
	return next, nil
}

func (a *PionCaptureAttempt) consumePacket(ctx context.Context, writer *captureBundleWriter, event captureRuntimeEvent) error {
	if event.packet == nil || event.track == nil {
		return fmt.Errorf("%w: empty RTP event", ErrInvalidCaptureAttempt)
	}
	if !a.ready {
		if err := a.emitReady(ctx, false); err != nil {
			return err
		}
	}
	return writer.addPacket(ctx, event.track, event.packet, event.at)
}

func (a *PionCaptureAttempt) emitReady(ctx context.Context, noPublisher bool) error {
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
		At: a.config.Now().UTC(), IdempotencyKey: key, NoPublisher: noPublisher,
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

func (a *PionCaptureAttempt) finishSuccess(ctx context.Context, writer *captureBundleWriter, plan captureplan.Plan) error {
	var result error
	if writer != nil {
		result = writer.close(recordingbundle.CloseReasonFinalStop, a.config.Now())
	}
	closeCtx, cancel := context.WithTimeout(context.Background(), a.config.CloseTimeout)
	providerErr := a.coordinator.Close(closeCtx, false)
	cancel()
	peerErr := a.peer.Close()
	if result = errors.Join(result, providerErr, peerErr); result != nil {
		return a.finishFailure(result, nil)
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
	a.mu.Lock()
	a.closed = true
	a.mu.Unlock()
	return nil
}

func (a *PionCaptureAttempt) finishFailure(cause error, writer *captureBundleWriter) error {
	result := cause
	if writer != nil {
		result = errors.Join(result, writer.close(recordingbundle.CloseReasonExplicit, a.config.Now()))
	}
	closeCtx, cancel := context.WithTimeout(context.Background(), a.config.CloseTimeout)
	a.mu.Lock()
	bootstrapped := a.bootstrapped
	a.mu.Unlock()
	if bootstrapped {
		result = errors.Join(result, a.coordinator.Close(closeCtx, true))
	}
	cancel()
	result = errors.Join(result, a.peer.Close())
	a.mu.Lock()
	a.closed = true
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
			return nil, nil, err
		}
		cancels[mid] = readerCancel
	}
	return cancels, cancel, nil
}

func startCaptureReader(ctx context.Context, peer CapturePeer, mid string, track CaptureMediaTrack, deadline time.Duration, events chan<- captureRuntimeEvent) (func(), error) {
	if peer == nil || track == nil || strings.TrimSpace(mid) == "" || deadline <= 0 {
		return nil, ErrInvalidCaptureAttempt
	}
	readerCtx, cancel := context.WithCancel(ctx)
	go func() {
		defer cancel()
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
			if err := sendCaptureRuntimeEvent(readerCtx, events, captureRuntimeEvent{mid: mid, track: track, packet: packet, at: time.Now().UTC()}); err != nil {
				return
			}
		}
	}()
	return cancel, nil
}

func sendCaptureRuntimeEvent(ctx context.Context, events chan<- captureRuntimeEvent, event captureRuntimeEvent) error {
	select {
	case events <- event:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	default:
		return ErrCaptureEventQueueFull
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
	started  bool
}

func (c *captureTrackClock) mediaMilliseconds(packet *rtp.Packet, codec captureplane.TrackKind) int64 {
	if !c.started {
		c.started = true
		c.baseTS = packet.Timestamp
		return 0
	}
	delta := int64(int32(packet.Timestamp - c.baseTS))
	if delta < 0 {
		delta = 0
	}
	rate := int64(90_000)
	if codec == captureplane.TrackKindAudio {
		rate = 48_000
	}
	return delta * 1_000 / rate
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
	startedAt      time.Time
	pendingGaps    []recordingbundle.Gap
	active         map[string]recordingbundle.TrackIdentity
	layout         recordingbundle.LayoutTimelineEvent
	hasLayout      bool
	clocks         map[string]*captureTrackClock
	lastMono       int64
	lastMedia      int64
}

func newCaptureBundleWriter(attempt *PionCaptureAttempt) *captureBundleWriter {
	return &captureBundleWriter{attempt: attempt, startedAt: attempt.config.Now(), active: make(map[string]recordingbundle.TrackIdentity), clocks: make(map[string]*captureTrackClock)}
}

func (w *captureBundleWriter) setTrack(track CaptureMediaTrack) {
	identity := track.CaptureTrack()
	w.active[string(identity.MID)] = recordingbundle.TrackIdentity{TrackID: identity.TrackReference.String(), Epoch: uint64(w.attempt.authority.CaptureEpoch), MID: identity.MID.String(), Codec: track.Codec(), Layer: identity.RequestedLayer.String()}
	if _, ok := w.clocks[string(identity.MID)]; !ok {
		w.clocks[string(identity.MID)] = &captureTrackClock{}
	}
}

func (w *captureBundleWriter) setLayout(ctx context.Context, plan captureplan.Plan, now time.Time) error {
	kind := recordingbundle.LayoutEventSnapshot
	if w.hasLayout && w.layout.Layout != string(plan.LayoutProfile()) {
		kind = recordingbundle.LayoutEventChanged
	}
	w.layout = recordingbundle.LayoutTimelineEvent{MonotonicMilliseconds: w.relative(now), MediaMilliseconds: w.lastMedia, Kind: kind, Revision: uint64(plan.Revision()), Layout: string(plan.LayoutProfile())}
	w.hasLayout = true
	if w.assembler != nil {
		if err := w.assembler.AddLayoutEvent(w.layout); err != nil {
			return err
		}
		if w.assembler.Closed() {
			return w.persist(ctx)
		}
	}
	return nil
}

func (w *captureBundleWriter) relative(now time.Time) int64 {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if now.Before(w.startedAt) {
		return 0
	}
	return now.Sub(w.startedAt).Milliseconds()
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
		if err := w.assembler.AddLayoutEvent(w.layout); err != nil {
			return err
		}
	}
	return nil
}

func (w *captureBundleWriter) addPacket(ctx context.Context, track CaptureMediaTrack, packet *rtp.Packet, at time.Time) error {
	if err := w.ensureAssembler(ctx); err != nil {
		return err
	}
	identity := track.CaptureTrack()
	clock := w.clocks[string(identity.MID)]
	if clock == nil {
		clock = &captureTrackClock{}
		w.clocks[string(identity.MID)] = clock
	}
	mono := w.relative(at)
	if mono < w.lastMono {
		mono = w.lastMono
	}
	media := clock.mediaMilliseconds(packet, identity.Kind)
	if media < w.lastMedia {
		media = w.lastMedia
	}
	w.lastMono, w.lastMedia = mono, media
	input := recordingbundle.MediaPacket{Track: w.active[string(identity.MID)], Packet: recordingbundle.RTPPacket{SequenceNumber: packet.SequenceNumber, ExtendedSequenceNumber: clock.sequence.Extend(packet.SequenceNumber), Timestamp: packet.Timestamp, SSRC: packet.SSRC, PayloadType: packet.PayloadType, Marker: packet.Marker, Payload: packet.Payload}, MonotonicMilliseconds: mono, MediaMilliseconds: media}
	err := w.assembler.AddPacket(input)
	if err == nil {
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

func (w *captureBundleWriter) reconcileTracks(ctx context.Context, plan captureplan.Plan, tracks []captureplane.PulledCaptureTrack, now time.Time) error {
	previousActive := w.active
	next := make(map[string]recordingbundle.TrackIdentity, len(tracks))
	for _, track := range tracks {
		identity := recordingbundle.TrackIdentity{TrackID: track.TrackReference.String(), Epoch: uint64(w.attempt.authority.CaptureEpoch), MID: track.MID.String(), Codec: "", Layer: track.RequestedLayer.String()}
		if existing, ok := w.active[track.MID.String()]; ok {
			identity.Codec = existing.Codec
		}
		next[track.MID.String()] = identity
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
			if err := w.assembler.AddTrackEvent(recordingbundle.TrackTimelineEvent{Kind: kind, Track: previous, MonotonicMilliseconds: w.lastMono, MediaMilliseconds: w.lastMedia, Reason: "plan_track_set_change"}); err != nil {
				return err
			}
			if w.assembler.Closed() {
				if err := w.persist(ctx); err != nil {
					return err
				}
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
	for _, track := range tracks {
		if _, ok := w.clocks[track.MID.String()]; !ok {
			w.clocks[track.MID.String()] = &captureTrackClock{}
		}
	}
	if changed && w.assembler != nil {
		keys := make([]string, 0, len(w.active))
		for key := range w.active {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			if _, existed := previousActive[key]; existed {
				continue
			}
			if err := w.assembler.AddTrackEvent(recordingbundle.TrackTimelineEvent{Kind: recordingbundle.TrackEventAdded, Track: w.active[key], MonotonicMilliseconds: w.lastMono, MediaMilliseconds: w.lastMedia, Reason: "plan_track_added"}); err != nil {
				return err
			}
			if w.assembler.Closed() {
				if err := w.persist(ctx); err != nil {
					return err
				}
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

func (w *captureBundleWriter) addTerminalGap(now time.Time) error {
	storageCtx, cancel := context.WithTimeout(context.Background(), w.attempt.config.CloseTimeout)
	defer cancel()
	if w.assembler == nil {
		if len(w.active) == 0 {
			return nil
		}
		if err := w.ensureAssembler(storageCtx); err != nil {
			return err
		}
	}
	endMono := w.relative(now)
	if endMono < w.lastMono {
		endMono = w.lastMono
	}
	return w.assembler.AddTerminalReadGap(recordingbundle.Gap{StartMonotonicMilliseconds: w.lastMono, EndMonotonicMilliseconds: endMono, StartMediaMilliseconds: w.lastMedia, EndMediaMilliseconds: w.lastMedia, Reason: "terminal_read", Terminal: true})
}

func (w *captureBundleWriter) close(reason recordingbundle.CloseReason, now time.Time) error {
	storageCtx, cancel := context.WithTimeout(context.Background(), w.attempt.config.CloseTimeout)
	defer cancel()
	if w.assembler != nil {
		if !w.assembler.Closed() {
			if err := w.assembler.Close(reason, w.relative(now), w.lastMedia); err != nil && !errors.Is(err, recordingbundle.ErrEmptyBundle) {
				return err
			}
		}
		if w.assembler.Closed() {
			if err := w.persist(storageCtx); err != nil {
				return err
			}
		}
	}
	if len(w.pendingGaps) > 0 {
		if err := w.ensureAssembler(storageCtx); err != nil {
			return err
		}
		if err := w.assembler.Close(reason, w.relative(now), w.lastMedia); err != nil {
			return err
		}
		if err := w.persist(storageCtx); err != nil {
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
