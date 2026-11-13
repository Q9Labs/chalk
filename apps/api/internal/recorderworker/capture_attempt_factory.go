package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/pion"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
)

const (
	defaultCaptureInitialPlanWait  = 10 * time.Second
	defaultCapturePlanWait         = 2 * time.Second
	defaultCaptureLateTrackWait    = time.Minute
	defaultCaptureRTPDeadline      = 250 * time.Millisecond
	defaultCaptureCloseTimeout     = 15 * time.Second
	defaultCaptureLifecycleRetry   = 100 * time.Millisecond
	captureVideoReorderWindow      = uint64(16)
	captureKeyFrameRequestSpacing  = time.Second
	captureBundleContentType       = "application/vnd.chalk.recording-bundle"
	legacyCaptureBundleContentType = "application/vnd.chalk.recording-bundle+json"
)

var (
	ErrInvalidCaptureAttempt = errors.New("invalid recorder capture attempt")
	ErrCaptureEventQueueFull = errors.New("recorder capture event queue is full")
	ErrCapturePeerTerminal   = errors.New("recorder capture peer reached a terminal state")
	ErrCaptureStorage        = errors.New("recorder capture storage is unavailable")
)

// PionCaptureAttemptFactory creates a single peer and coordinator for each
// server-issued claim. CaptureEpoch is read from the envelope and is never
// incremented by this factory.
type PionCaptureAttemptFactory struct {
	signaling recordercapture.SignalingPort
	plans     recordercapture.PlanSource
	keys      CaptureKeyPort
	objects   CaptureObjectPort
	bundles   CaptureBundleSink
	lifecycle CaptureLifecyclePort
	peer      func(pion.Config) (CapturePeer, error)
	coord     recordercapture.Config
	config    CaptureAttemptConfig
}

// PionCaptureAttemptFactoryConfig contains the runtime edges. The production
// peer factory is provided when NewPeer is nil; all storage and lifecycle
// edges remain explicit ports until their authority routes are wired.
type PionCaptureAttemptFactoryConfig struct {
	Signaling   recordercapture.SignalingPort
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
