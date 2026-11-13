package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
)

// bindTracks binds every expected MID that sends its first RTP packet before ctx
// ends. A MID that stays silent is returned in missing instead of failing the
// attempt, so one dead microphone cannot cost the Recording of everyone else.
// With nothing bound at all the attempt still fails: the pull itself is broken.
func (a *PionCaptureAttempt) bindTracks(ctx context.Context, tracks []captureplane.PulledCaptureTrack) (map[string]CaptureMediaTrack, []captureplane.PulledCaptureTrack, error) {
	ordered := append([]captureplane.PulledCaptureTrack(nil), tracks...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].MID < ordered[j].MID })
	bound := make(map[string]CaptureMediaTrack, len(ordered))
	var missing []captureplane.PulledCaptureTrack
	var firstMiss error
	for _, expected := range ordered {
		track, err := a.bindTrack(ctx, expected)
		switch {
		case err == nil:
			bound[string(expected.MID)] = track
		case errors.Is(err, errCaptureTrackSilent):
			missing = append(missing, expected)
			if firstMiss == nil {
				firstMiss = err
			}
		default:
			return nil, nil, err
		}
	}
	if len(bound) == 0 && firstMiss != nil {
		return nil, nil, firstMiss
	}
	return bound, missing, nil
}

// bindAnchors returns the first-packet time for each track that is new in next.
// Binding waits for every planned track before any reader starts, and each
// bound track queues its packets meanwhile, so a reader's first read comes
// after the track's first packet: by the rest of the bind for an early track,
// and by seconds when a planned track is silent. Stamping a track with the time
// the peer bound it keeps its place on the Recording's clock. Stamping the read
// instead would give every track one shared start, and an audio track bound
// hundreds of milliseconds before a camera would sound that much later than the
// picture it belongs to.
func bindAnchors(writer *captureBundleWriter, next, previous map[string]CaptureMediaTrack) map[string]time.Time {
	anchors := make(map[string]time.Time, len(next))
	for mid, track := range next {
		if before, ok := previous[mid]; ok && sameCaptureBinding(before, track) {
			continue
		}
		if bound, ok := track.(interface{ BoundAt() time.Time }); ok {
			anchors[mid] = writer.clampAnchor(bound.BoundAt())
		}
	}
	return anchors
}

// errCaptureTrackSilent marks a planned MID that sent no RTP before the wait ended.
var errCaptureTrackSilent = errors.New("capture track sent no RTP")

// bindTrack waits for one MID's first packet. It wraps errCaptureTrackSilent only
// when the wait itself ran out while the attempt is still live.
func (a *PionCaptureAttempt) bindTrack(ctx context.Context, expected captureplane.PulledCaptureTrack) (CaptureMediaTrack, error) {
	track, err := a.peer.WaitForTrack(ctx, expected.MID)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, fmt.Errorf("wait for capture MID %s: %w: %w", expected.MID, errCaptureTrackSilent, err)
		}
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
	return track, nil
}

type captureTrackBindResult struct {
	tracks  map[string]CaptureMediaTrack
	missing []captureplane.PulledCaptureTrack
	err     error
}

func (a *PionCaptureAttempt) bindTracksWhileWatchingPlans(ctx context.Context, writer *captureBundleWriter, plan captureplan.Plan, snapshot recordercapture.Snapshot, planEvents <-chan capturePlanEvent, runtimeEvents <-chan captureRuntimeEvent, currentReaders map[string]CaptureMediaTrack, late *lateTrackWatch) (map[string]CaptureMediaTrack, captureplan.Plan, bool, error) {
	if err := writer.observePlan(plan); err != nil {
		return nil, captureplan.Plan{}, false, err
	}
bindPlan:
	for {
		bindCtx, cancelBind := context.WithTimeout(ctx, a.config.InitialPlanWait)
		result := make(chan captureTrackBindResult, 1)
		expected := late.bindable(snapshot.Tracks)
		go func() {
			var bound captureTrackBindResult
			defer func() {
				if recover() != nil {
					bound.err = capturePanicError()
				}
				result <- bound
			}()
			bound.tracks, bound.missing, bound.err = a.bindTracks(bindCtx, expected)
		}()

		for {
			select {
			case <-ctx.Done():
				cancelBind()
				<-result
				return nil, captureplan.Plan{}, false, ctx.Err()
			case bound := <-result:
				cancelBind()
				if err := ctx.Err(); err != nil {
					return nil, captureplan.Plan{}, false, err
				}
				if bound.err == nil {
					late.update(snapshot.Tracks, bound.missing)
				}
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
				if err := a.consumeQueuedPackets(ctx, writer, event, runtimeEvents, func(next captureRuntimeEvent) bool {
					return captureRuntimeEventMatchesPlannedReaders(next, currentReaders, snapshot.Tracks)
				}); err != nil {
					cancelBind()
					<-result
					return nil, captureplan.Plan{}, false, err
				}
			case event := <-planEvents:
				if event.checkpointNoRTP {
					if err := writer.checkpointNoRTP(ctx, event.at); err == nil {
						continue
					} else {
						cancelBind()
						<-result
						return nil, captureplan.Plan{}, false, err
					}
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
				if err := writer.observePlan(event.plan); err != nil {
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

func (a *PionCaptureAttempt) applyBoundTracks(ctx context.Context, writer *captureBundleWriter, plan captureplan.Plan, next, previous map[string]CaptureMediaTrack, readerCancels map[string]func(), events chan<- captureRuntimeEvent, firstPacketAt map[string]time.Time) error {
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
		cancel, err := startCaptureReader(ctx, a.peer, mid, track, a.config.RTPReadDeadline, a.config.KeyFrameInterval, events, firstPacketAt[mid])
		if err != nil {
			return err
		}
		readerCancels[mid] = cancel
	}
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
