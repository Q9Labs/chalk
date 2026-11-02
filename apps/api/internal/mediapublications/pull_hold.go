package mediapublications

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

const (
	pullHoldPollInterval = 200 * time.Millisecond
	// A pull is held only while its publication is younger than this. Rig runs showed the
	// publish answer arriving at most 5.1 s before the publisher connects.
	pullHoldYoungWindow = 10 * time.Second
	pullHoldMaxEntries  = 4096
)

type pullHoldOutcome string

const (
	pullHoldOutcomeActive         pullHoldOutcome = "active"
	pullHoldOutcomeBudgetExpired  pullHoldOutcome = "budget_expired"
	pullHoldOutcomeSessionMissing pullHoldOutcome = "session_missing"
	pullHoldOutcomeReadFailed     pullHoldOutcome = "read_failed"
	pullHoldOutcomeCancelled      pullHoldOutcome = "cancelled"
)

var pullHolds, _ = otel.Meter("github.com/q9labs/chalk/apps/api/internal/mediapublications").Int64Counter(
	"chalk.media.pull_hold",
	metric.WithDescription("Listener pulls held until Cloudflare lists the publisher track as active, by outcome"),
)

var pullHoldWait, _ = otel.Meter("github.com/q9labs/chalk/apps/api/internal/mediapublications").Float64Histogram(
	"chalk.media.pull_hold_wait",
	metric.WithDescription("Time a listener pull waited for the publisher track to become active"),
	metric.WithUnit("ms"),
)

// PullHoldConfig turns on the hold. The zero value is off.
type PullHoldConfig struct {
	Enabled bool
	Budget  time.Duration
}

// PullHoldResult describes one hold. Waited is zero when no track needed one.
type PullHoldResult struct {
	Held    bool
	Waited  time.Duration
	Polls   int
	Outcome pullHoldOutcome
}

// RemotePullHolder delays a listener's pull of a young publication until Cloudflare lists the
// publisher's track as active, or the budget runs out. It never fails the pull.
type RemotePullHolder interface {
	HoldRemotePulls(context.Context, []RemoteTrackIdentity, PublisherSessionReader) PullHoldResult
}

type pullHoldEntry struct {
	publishedAt time.Time
	active      bool
}

// pullHold remembers recent publishes in memory. A pull handled by an instance that did not see
// the publish finds no entry and is forwarded at once, which is the behavior without the hold.
type pullHold struct {
	budget time.Duration
	now    func() time.Time
	sleep  func(context.Context, time.Duration)

	mu      sync.Mutex
	entries map[RemoteTrackIdentity]*pullHoldEntry
	polling map[string]struct{}
}

func newPullHold(config PullHoldConfig, now func() time.Time) *pullHold {
	if !config.Enabled || config.Budget <= 0 {
		return nil
	}
	return &pullHold{
		budget:  config.Budget,
		now:     now,
		sleep:   sleepContext,
		entries: make(map[RemoteTrackIdentity]*pullHoldEntry),
		polling: make(map[string]struct{}),
	}
}

func sleepContext(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

// WithPullHold returns the service with the pull hold configured.
func (s Service) WithPullHold(config PullHoldConfig) Service {
	now := s.now
	if now == nil {
		now = time.Now
	}
	s.pullHold = newPullHold(config, now)
	return s
}

func (s Service) HoldRemotePulls(ctx context.Context, tracks []RemoteTrackIdentity, reader PublisherSessionReader) PullHoldResult {
	return s.pullHold.hold(ctx, tracks, reader)
}

func (h *pullHold) notePublished(connectionID string, trackNames []string) {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.now()
	h.pruneLocked(now)
	for _, name := range trackNames {
		if len(h.entries) >= pullHoldMaxEntries {
			return
		}
		h.entries[RemoteTrackIdentity{ConnectionID: connectionID, TrackName: name}] = &pullHoldEntry{publishedAt: now}
	}
}

func (h *pullHold) pruneLocked(now time.Time) {
	if len(h.entries) < pullHoldMaxEntries/2 {
		return
	}
	for identity, entry := range h.entries {
		if now.Sub(entry.publishedAt) >= pullHoldYoungWindow {
			delete(h.entries, identity)
		}
	}
}

// pending returns the tracks that are young and not yet known to be active.
func (h *pullHold) pending(tracks []RemoteTrackIdentity) []RemoteTrackIdentity {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.now()
	var pending []RemoteTrackIdentity
	for _, identity := range tracks {
		entry, ok := h.entries[identity]
		if !ok || entry.active {
			continue
		}
		if now.Sub(entry.publishedAt) >= pullHoldYoungWindow {
			delete(h.entries, identity)
			continue
		}
		pending = append(pending, identity)
	}
	return pending
}

func (h *pullHold) hold(ctx context.Context, tracks []RemoteTrackIdentity, reader PublisherSessionReader) PullHoldResult {
	if h == nil || reader == nil || len(tracks) == 0 {
		return PullHoldResult{}
	}
	pending := h.pending(tracks)
	if len(pending) == 0 {
		return PullHoldResult{}
	}
	started := h.now()
	deadline := started.Add(h.budget)
	holdCtx, cancel := context.WithTimeout(ctx, h.budget)
	defer cancel()
	result := PullHoldResult{Held: true}
	for len(pending) > 0 {
		var outcome pullHoldOutcome
		pending, outcome = h.poll(holdCtx, pending, reader, &result)
		if outcome != "" {
			result.Outcome = outcome
			break
		}
		if len(pending) == 0 {
			result.Outcome = pullHoldOutcomeActive
			break
		}
		h.sleep(holdCtx, pullHoldPollInterval)
		if holdCtx.Err() != nil || !h.now().Before(deadline) {
			result.Outcome = pullHoldOutcomeBudgetExpired
			if ctx.Err() != nil {
				result.Outcome = pullHoldOutcomeCancelled
			}
			break
		}
	}
	result.Waited = h.now().Sub(started)
	h.record(ctx, result, len(tracks))
	return result
}

// poll reads each publisher session that still has pending tracks, at most once per session
// across concurrent listeners, and returns the tracks still not active. A non-empty outcome
// ends the hold early.
func (h *pullHold) poll(ctx context.Context, pending []RemoteTrackIdentity, reader PublisherSessionReader, result *PullHoldResult) ([]RemoteTrackIdentity, pullHoldOutcome) {
	byConnection := make(map[string]struct{})
	for _, identity := range pending {
		byConnection[identity.ConnectionID] = struct{}{}
	}
	for connectionID := range byConnection {
		if !h.claimPoll(connectionID) {
			continue
		}
		result.Polls++
		session, err := reader(ctx, connectionID)
		h.releasePoll(connectionID)
		if err != nil {
			if ctx.Err() != nil {
				return pending, ""
			}
			return pending, pullHoldOutcomeReadFailed
		}
		if !session.Found {
			return pending, pullHoldOutcomeSessionMissing
		}
		h.markActive(connectionID, session)
	}
	return h.pending(pending), ""
}

func (h *pullHold) claimPoll(connectionID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, busy := h.polling[connectionID]; busy {
		return false
	}
	h.polling[connectionID] = struct{}{}
	return true
}

func (h *pullHold) releasePoll(connectionID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.polling, connectionID)
}

func (h *pullHold) markActive(connectionID string, session PublisherSession) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, track := range session.Tracks {
		if !track.Active {
			continue
		}
		if entry, ok := h.entries[RemoteTrackIdentity{ConnectionID: connectionID, TrackName: track.TrackName}]; ok {
			entry.active = true
		}
	}
}

func (h *pullHold) record(ctx context.Context, result PullHoldResult, requested int) {
	attrs := metric.WithAttributes(attribute.String("outcome", string(result.Outcome)))
	pullHolds.Add(ctx, 1, attrs)
	pullHoldWait.Record(ctx, float64(result.Waited.Milliseconds()), attrs)
	level := slog.LevelInfo
	if result.Outcome == pullHoldOutcomeBudgetExpired {
		level = slog.LevelWarn
	}
	slog.Log(ctx, level, "held listener pull for a young media publication",
		"event", "media_publication.pull_hold",
		"outcome", string(result.Outcome),
		"waited_ms", result.Waited.Milliseconds(),
		"budget_ms", h.budget.Milliseconds(),
		"session_reads", result.Polls,
		"requested_tracks", requested,
	)
}
