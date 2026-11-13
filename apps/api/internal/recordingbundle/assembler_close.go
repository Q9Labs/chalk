package recordingbundle

import (
	"fmt"
	"sort"
)

// Stop closes with final_stop at the supplied worker clocks. A stop timestamp
// past the hard boundary does not expand the media range beyond received data.
func (a *Assembler) Stop(monotonicMilliseconds, mediaMilliseconds int64) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.checkOpenLocked(); err != nil {
		return err
	}
	if monotonicMilliseconds < 0 || mediaMilliseconds < 0 {
		return fmt.Errorf("%w: stop time", ErrNonMonotonicTime)
	}
	if !a.hasTime {
		a.touchTimeLocked(monotonicMilliseconds, mediaMilliseconds)
	} else if err := a.validateDurationLocked(monotonicMilliseconds, mediaMilliseconds); err == nil {
		a.touchTimeLocked(monotonicMilliseconds, mediaMilliseconds)
	}
	return a.closeLocked(CloseReasonFinalStop, a.endMono, a.endMedia)
}

func (a *Assembler) Close(reason CloseReason, monotonicMilliseconds, mediaMilliseconds int64) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.checkOpenLocked(); err != nil {
		return err
	}
	if !reason.valid() {
		return fmt.Errorf("%w: close reason %q", ErrInvalidBundle, reason)
	}
	if monotonicMilliseconds < 0 || mediaMilliseconds < 0 {
		return fmt.Errorf("%w: close time", ErrNonMonotonicTime)
	}
	if !a.hasTime {
		a.touchTimeLocked(monotonicMilliseconds, mediaMilliseconds)
	} else {
		if err := a.validateDurationLocked(monotonicMilliseconds, mediaMilliseconds); err != nil {
			return err
		}
		a.touchTimeLocked(monotonicMilliseconds, mediaMilliseconds)
	}
	return a.closeLocked(reason, a.endMono, a.endMedia)
}

func (a *Assembler) CloseNow(reason CloseReason) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.checkOpenLocked(); err != nil {
		return err
	}
	if !a.hasTime {
		return ErrEmptyBundle
	}
	return a.closeLocked(reason, a.endMono, a.endMedia)
}

func (a *Assembler) closeLocked(reason CloseReason, monotonicMilliseconds, mediaMilliseconds int64) error {
	if a.closed {
		return a.closeErr
	}
	if !reason.valid() {
		return fmt.Errorf("%w: close reason %q", ErrInvalidBundle, reason)
	}
	if len(a.fragments) == 0 && len(a.trackEvents) == 0 && len(a.layoutEvents) == 0 && len(a.gaps) == 0 {
		return ErrEmptyBundle
	}
	if !a.hasTime {
		a.touchTimeLocked(monotonicMilliseconds, mediaMilliseconds)
	}
	if monotonicMilliseconds < a.endMono {
		monotonicMilliseconds = a.endMono
	}
	if mediaMilliseconds < a.endMedia {
		mediaMilliseconds = a.endMedia
	}
	if monotonicMilliseconds-a.startMono > a.cfg.MaxDurationMilliseconds || mediaMilliseconds-a.startMedia > a.cfg.MaxDurationMilliseconds {
		return ErrDurationLimit
	}
	a.endMono, a.endMedia = monotonicMilliseconds, mediaMilliseconds
	bundle := Bundle{
		Version: a.cfg.Encryption.BundleSchema,
		Manifest: Manifest{
			Version:                a.cfg.Encryption.BundleSchema,
			RecordingID:            a.cfg.RecordingID,
			CaptureEpoch:           a.cfg.CaptureEpoch,
			Sequence:               a.cfg.Sequence,
			RecorderEnvelopeDigest: a.cfg.RecorderEnvelopeDigest,
			MonotonicRange:         TimeRange{StartMilliseconds: a.startMono, EndMilliseconds: a.endMono},
			MediaRange:             TimeRange{StartMilliseconds: a.startMedia, EndMilliseconds: a.endMedia},
			CloseReason:            reason,
			AllocationVersion:      a.cfg.AllocationVersion,
			Encryption:             a.cfg.Encryption,
		},
		Fragments:      make([]RTPFragment, 0, len(a.fragments)),
		TrackTimeline:  append([]TrackTimelineEvent(nil), a.trackEvents...),
		LayoutTimeline: append([]LayoutTimelineEvent(nil), a.layoutEvents...),
		Gaps:           append([]Gap(nil), a.gaps...),
	}
	for _, fragment := range a.fragments {
		bundle.Fragments = append(bundle.Fragments, RTPFragment{Track: fragment.Track, Packets: append([]RTPPacket(nil), fragment.Packets...)})
	}
	encoded, err := Encode(bundle)
	if err != nil {
		return err
	}
	decoded, err := Decode(encoded)
	if err != nil {
		return err
	}
	a.closed = true
	a.closeReason = reason
	a.sealed = &SealedBundle{Bundle: decoded, Bytes: append([]byte(nil), encoded...), ContentBytes: a.contentBytes, PacketCount: a.packetCount}
	return nil
}

func (a *Assembler) failLimitLocked(limit error) error {
	if a.closed {
		return a.closeErr
	}
	a.closed = true
	a.closeReason = CloseReasonLimitExceeded
	a.closeErr = limit
	return limit
}

// Closed reports whether the assembler has sealed or failed closed.
func (a *Assembler) Closed() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.closed
}

// Snapshot returns a deep copy. Callers can safely mutate the returned
// buffers after this method returns; the assembler retains its own copy.
func (a *Assembler) Snapshot() (SealedBundle, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.closed {
		return SealedBundle{}, ErrAssemblerNotClosed
	}
	if a.sealed == nil {
		if a.closeErr != nil {
			return SealedBundle{}, a.closeErr
		}
		return SealedBundle{}, ErrAssemblerNotClosed
	}
	output := SealedBundle{Bundle: cloneBundle(a.sealed.Bundle), Bytes: append([]byte(nil), a.sealed.Bytes...), ContentBytes: a.sealed.ContentBytes, PacketCount: a.sealed.PacketCount}
	return output, nil
}

func (a *Assembler) Seal() (SealedBundle, error) { return a.Snapshot() }

// Fragments returns no mutable internal state. It is useful for diagnostics
// before a bundle is sealed without exposing caller-owned payload buffers.
func (a *Assembler) Fragments() []RTPFragment {
	a.mu.Lock()
	defer a.mu.Unlock()
	fragments := make([]RTPFragment, 0, len(a.fragments))
	for _, fragment := range a.fragments {
		fragments = append(fragments, RTPFragment{Track: fragment.Track, Packets: append([]RTPPacket(nil), fragment.Packets...)})
	}
	sort.Slice(fragments, func(i, j int) bool { return trackIdentityLess(fragments[i].Track, fragments[j].Track) })
	return fragments
}
