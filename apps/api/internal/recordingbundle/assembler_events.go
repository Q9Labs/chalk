package recordingbundle

import (
	"fmt"
)

// AddTrackEvent appends an explicit track timeline event. A changed track set
// is included in the current bundle and closes that bundle early.
func (a *Assembler) AddTrackEvent(event TrackTimelineEvent) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.checkOpenLocked(); err != nil {
		return err
	}
	if !event.Kind.valid() {
		return fmt.Errorf("%w: track event kind %q", ErrInvalidBundle, event.Kind)
	}
	if event.MonotonicMilliseconds < 0 || event.MediaMilliseconds < 0 {
		return fmt.Errorf("%w: track event time", ErrNonMonotonicTime)
	}
	if err := event.Track.validate(); err != nil {
		return err
	}
	if event.Kind == TrackEventEpochChanged {
		if previous, exists := a.trackEpochs[event.Track.TrackID]; exists && event.Track.Epoch <= previous {
			return ErrTrackEpochChangeNeeded
		}
		a.trackEpochs[event.Track.TrackID] = event.Track.Epoch
	}
	if err := a.validateDurationLocked(event.MonotonicMilliseconds, event.MediaMilliseconds); err != nil {
		return err
	}
	a.touchTimeLocked(event.MonotonicMilliseconds, event.MediaMilliseconds)
	a.trackEvents = append(a.trackEvents, event)
	if event.Kind == TrackEventEpochChanged {
		identityKey := event.Track.TrackID + "\x00" + fmt.Sprintf("%020d", event.Track.Epoch)
		a.trackBindings[identityKey] = event.Track
	}
	if len(a.trackEvents) > MaxTimelineEvents {
		return a.failLimitLocked(ErrContentLimit)
	}
	if event.Kind != TrackEventAdded || len(a.fragments) > 0 {
		if event.Kind == TrackEventRemoved || event.Kind == TrackEventReplaced || event.Kind == TrackEventEpochChanged || len(a.fragments) > 0 {
			return a.closeLocked(CloseReasonTrackSetChange, a.endMono, a.endMedia)
		}
	}
	if a.durationLocked() >= a.cfg.TargetDurationMilliseconds {
		return a.closeLocked(CloseReasonCadence, a.endMono, a.endMedia)
	}
	return nil
}

func (a *Assembler) AddLayoutEvent(event LayoutTimelineEvent) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.checkOpenLocked(); err != nil {
		return err
	}
	if !event.Kind.valid() || event.Revision == 0 || event.Layout == "" {
		return fmt.Errorf("%w: layout event is invalid", ErrInvalidBundle)
	}
	if event.MonotonicMilliseconds < 0 || event.MediaMilliseconds < 0 {
		return fmt.Errorf("%w: layout event time", ErrNonMonotonicTime)
	}
	if err := a.validateDurationLocked(event.MonotonicMilliseconds, event.MediaMilliseconds); err != nil {
		return err
	}
	a.touchTimeLocked(event.MonotonicMilliseconds, event.MediaMilliseconds)
	a.layoutEvents = append(a.layoutEvents, event)
	if len(a.layoutEvents) > MaxTimelineEvents {
		return a.failLimitLocked(ErrContentLimit)
	}
	if a.durationLocked() >= a.cfg.TargetDurationMilliseconds {
		return a.closeLocked(CloseReasonCadence, a.endMono, a.endMedia)
	}
	return nil
}

// AddGap places a gap in the current bundle when it has no media yet. Once
// content exists, it queues the gap for the next bundle so a replacement or
// terminal read boundary cannot be hidden inside an earlier bundle.
func (a *Assembler) AddGap(gap Gap) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		if err := gap.validate(); err != nil {
			return err
		}
		if len(a.pendingGaps) == MaxGaps {
			return ErrContentLimit
		}
		a.pendingGaps = append(a.pendingGaps, gap)
		return nil
	}
	if a.packetCount > 0 || len(a.trackEvents) > 0 || len(a.layoutEvents) > 0 {
		if err := gap.validate(); err != nil {
			return err
		}
		if len(a.pendingGaps) == MaxGaps {
			return ErrContentLimit
		}
		a.pendingGaps = append(a.pendingGaps, gap)
		return nil
	}
	return a.addGapLocked(gap)
}

func (a *Assembler) addGapLocked(gap Gap) error {
	if err := gap.validate(); err != nil {
		return err
	}
	if len(a.gaps) == MaxGaps {
		return ErrContentLimit
	}
	if a.hasTime {
		if gap.EndMonotonicMilliseconds < a.startMono || gap.StartMonotonicMilliseconds > a.startMono+a.cfg.MaxDurationMilliseconds {
			return ErrDurationLimit
		}
	} else {
		a.touchTimeLocked(gap.StartMonotonicMilliseconds, gap.StartMediaMilliseconds)
	}
	a.gaps = append(a.gaps, gap)
	a.touchTimeLocked(gap.StartMonotonicMilliseconds, gap.StartMediaMilliseconds)
	a.touchTimeLocked(gap.EndMonotonicMilliseconds, gap.EndMediaMilliseconds)
	return nil
}

func (a *Assembler) AddReplacementGap(gap Gap) error {
	gap.Terminal = false
	if gap.ReplacementAttempt == 0 {
		return fmt.Errorf("%w: replacement attempt must be positive", ErrInvalidBundle)
	}
	if gap.Reason == "" {
		gap.Reason = "worker_replacement"
	}
	return a.AddGap(gap)
}

func (a *Assembler) AddTerminalReadGap(gap Gap) error {
	gap.Terminal = true
	if gap.Reason == "" {
		gap.Reason = "terminal_read"
	}
	return a.AddGap(gap)
}

func (a *Assembler) TrackEpochChanged(event TrackTimelineEvent) error {
	event.Kind = TrackEventEpochChanged
	return a.AddTrackEvent(event)
}

// PendingGaps returns gaps queued after this assembler closed. Pass them as
// AssemblerConfig.InitialGaps to the replacement attempt's assembler.
func (a *Assembler) PendingGaps() []Gap {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]Gap(nil), a.pendingGaps...)
}

// TakePendingGaps atomically drains the queue for the next assembler.
func (a *Assembler) TakePendingGaps() []Gap {
	a.mu.Lock()
	defer a.mu.Unlock()
	gaps := append([]Gap(nil), a.pendingGaps...)
	a.pendingGaps = nil
	return gaps
}
