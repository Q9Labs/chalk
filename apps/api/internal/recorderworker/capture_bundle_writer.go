package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

// captureBundleWriter is the runtime's bounded handoff from RTP to the
// canonical assembler, encryption, upload, and API commit ports.
type plannedTrackEpoch struct {
	binding captureplane.CaptureTrack
	epoch   uint64
}

type captureBundleWriter struct {
	attempt        *PionCaptureAttempt
	key            []byte
	contextDigest  []byte
	assembler      *recordingbundle.Assembler
	pendingObject  *pendingCaptureObject
	reservation    BundleReservation
	reserveOrdinal uint64
	origin         time.Time
	pendingGaps    []recordingbundle.Gap
	active         map[string]recordingbundle.TrackIdentity
	bindings       map[string]captureplane.PulledCaptureTrack
	plannedEpochs  map[string]plannedTrackEpoch
	layout         recordingbundle.LayoutTimelineEvent
	hasLayout      bool
	clocks         map[string]*captureTrackClock
	lastMono       int64
	recoveryStart  time.Time
	earliestAnchor time.Time
	lastMedia      int64
	terminalGap    bool
}

type pendingCaptureObject struct {
	assembler       *recordingbundle.Assembler
	reservation     string
	body            []byte
	checksum        string
	upload          CaptureBundleUpload
	finalized       bool
	uploadAttempted bool
}

func newCaptureBundleWriter(attempt *PionCaptureAttempt) *captureBundleWriter {
	writer := &captureBundleWriter{attempt: attempt, active: make(map[string]recordingbundle.TrackIdentity), bindings: make(map[string]captureplane.PulledCaptureTrack), clocks: make(map[string]*captureTrackClock)}
	if attempt.authority.CaptureReadyAt != nil {
		writer.origin = attempt.authority.CaptureReadyAt.UTC()
		writer.recoveryStart = attempt.config.Now().UTC()
		// A replacement epoch has no authoritative prior bundle end in its
		// envelope. Start its no-RTP bookkeeping at the local recovery boundary;
		// the decoder represents the interval from the prior epoch as recovery.
		recoveryStart := writer.relative(attempt.config.Now().UTC())
		writer.lastMono = recoveryStart
		writer.lastMedia = recoveryStart
	}
	return writer
}

// clampAnchor keeps a first-packet time out of the recovery gap: a replacement
// attempt starts its clock at its own recovery boundary. A first attempt has
// none, so tracks bound during negotiation keep their offsets from each other.
func (w *captureBundleWriter) clampAnchor(at time.Time) time.Time {
	if at.Before(w.recoveryStart) {
		return w.recoveryStart
	}
	return at
}

// startAt records the earliest first-packet time among the initial readers. The
// Recording's clock starts there, not at the first event the loop happens to
// take, so a track stamped earlier than that event keeps its offset.
func (w *captureBundleWriter) startAt(anchors map[string]time.Time) {
	for _, at := range anchors {
		if w.earliestAnchor.IsZero() || at.Before(w.earliestAnchor) {
			w.earliestAnchor = at
		}
	}
}

// firstPacketOrigin returns the Recording's start for a first event taken at at.
func (w *captureBundleWriter) firstPacketOrigin(at time.Time) time.Time {
	if !w.earliestAnchor.IsZero() && w.earliestAnchor.Before(at) {
		return w.earliestAnchor
	}
	return at
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
	if w.origin.IsZero() || w.terminalGap {
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
