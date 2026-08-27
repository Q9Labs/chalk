package recordingbundle

import (
	"errors"
	"fmt"
	"sort"
	"sync"
)

type AssemblerConfig struct {
	RecordingID                string
	CaptureEpoch               uint64
	Sequence                   uint64
	RecorderEnvelopeDigest     string
	Encryption                 EncryptionContext
	AllocationVersion          int64
	TargetDurationMilliseconds int64
	MaxDurationMilliseconds    int64
	MaxContentBytes            int
	MaxPackets                 int
	MaxTracks                  int
	InitialGaps                []Gap
}

type SealedBundle struct {
	Bundle       Bundle
	Bytes        []byte
	ContentBytes int
	PacketCount  int
}

type Assembler struct {
	mu sync.Mutex

	cfg AssemblerConfig

	hasTime      bool
	startMono    int64
	endMono      int64
	startMedia   int64
	endMedia     int64
	contentBytes int
	packetCount  int
	closed       bool
	closeReason  CloseReason
	closeErr     error
	sealed       *SealedBundle

	fragments     map[string]*RTPFragment
	trackBindings map[string]TrackIdentity
	trackEpochs   map[string]uint64
	trackEvents   []TrackTimelineEvent
	layoutEvents  []LayoutTimelineEvent
	gaps          []Gap
	pendingGaps   []Gap
}

func NewAssembler(config AssemblerConfig) (*Assembler, error) {
	if config.TargetDurationMilliseconds == 0 {
		config.TargetDurationMilliseconds = TargetBundleDurationMilliseconds
	}
	if config.MaxDurationMilliseconds == 0 {
		config.MaxDurationMilliseconds = MaxBundleDurationMilliseconds
	}
	if config.MaxContentBytes == 0 {
		config.MaxContentBytes = int(MaxContentBytes)
	}
	if config.MaxPackets == 0 {
		config.MaxPackets = MaxPackets
	}
	if config.MaxTracks == 0 {
		config.MaxTracks = MaxTracks
	}
	if err := validateAssemblerConfig(config); err != nil {
		return nil, err
	}
	config.InitialGaps = append([]Gap(nil), config.InitialGaps...)
	assembler := &Assembler{
		cfg:           config,
		fragments:     make(map[string]*RTPFragment),
		trackBindings: make(map[string]TrackIdentity),
		trackEpochs:   make(map[string]uint64),
	}
	for _, gap := range config.InitialGaps {
		if err := assembler.addGapLocked(gap); err != nil {
			return nil, err
		}
	}
	return assembler, nil
}

func validateAssemblerConfig(config AssemblerConfig) error {
	if err := validateIdentifier("recording_id", config.RecordingID, true); err != nil {
		return err
	}
	if config.CaptureEpoch == 0 {
		return fmt.Errorf("%w: capture epoch must be positive", ErrInvalidBundle)
	}
	if !validSHA256Hex(config.RecorderEnvelopeDigest) {
		return fmt.Errorf("%w: recorder envelope digest is invalid", ErrInvalidBundle)
	}
	if config.AllocationVersion <= 0 {
		return fmt.Errorf("%w: allocation version must be positive", ErrInvalidBundle)
	}
	if err := validateIdentifier("encryption recording_id", config.Encryption.RecordingID, true); err != nil {
		return err
	}
	if config.Encryption.RecordingID != config.RecordingID {
		return fmt.Errorf("%w: encryption recording does not match assembler", ErrInvalidBundle)
	}
	if err := config.Encryption.validate(); err != nil {
		return err
	}
	if config.TargetDurationMilliseconds <= 0 || config.MaxDurationMilliseconds <= 0 || config.TargetDurationMilliseconds > config.MaxDurationMilliseconds || config.MaxDurationMilliseconds > MaxBundleDurationMilliseconds {
		return fmt.Errorf("%w: assembler duration limits are invalid", ErrInvalidBundle)
	}
	if config.MaxContentBytes <= 0 || config.MaxContentBytes > int(MaxContentBytes) || config.MaxPackets <= 0 || config.MaxPackets > MaxPackets || config.MaxTracks <= 0 || config.MaxTracks > MaxTracks {
		return fmt.Errorf("%w: assembler content limits are invalid", ErrInvalidBundle)
	}
	if len(config.InitialGaps) > MaxGaps {
		return fmt.Errorf("%w: too many initial gaps", ErrContentLimit)
	}
	return nil
}

// AddPacket copies the packet and accepts out-of-order arrivals. Once the
// target cadence is reached, the boundary packet is included and the
// assembler seals itself. A packet beyond the hard limit is left for the next
// assembler and returns ErrDurationLimit.
func (a *Assembler) AddPacket(input MediaPacket) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.checkOpenLocked(); err != nil {
		return err
	}
	if input.MonotonicMilliseconds < 0 || input.MediaMilliseconds < 0 {
		return fmt.Errorf("%w: packet time", ErrNonMonotonicTime)
	}
	if err := input.Track.validate(); err != nil {
		return err
	}
	if len(input.Packet.Payload) > MaxPacketPayloadBytes {
		return a.failLimitLocked(ErrContentLimit)
	}
	if a.packetCount == a.cfg.MaxPackets {
		return a.failLimitLocked(ErrPacketLimit)
	}
	if a.contentBytes > a.cfg.MaxContentBytes-len(input.Packet.Payload) {
		return a.failLimitLocked(ErrContentLimit)
	}
	if err := a.validateTrackBindingLocked(input.Track); err != nil {
		return err
	}
	if err := a.validateDurationLocked(input.MonotonicMilliseconds, input.MediaMilliseconds); err != nil {
		if errors.Is(err, ErrDurationLimit) {
			if a.hasTime {
				_ = a.closeLocked(CloseReasonMaxDuration, a.endMono, a.endMedia)
			}
		}
		return err
	}
	a.touchTimeLocked(input.MonotonicMilliseconds, input.MediaMilliseconds)
	key := trackIdentityKey(input.Track)
	fragment := a.fragments[key]
	if fragment == nil {
		if len(a.fragments) == a.cfg.MaxTracks {
			return a.failLimitLocked(ErrContentLimit)
		}
		fragment = &RTPFragment{Track: input.Track, Packets: make([]RTPPacket, 0, 8)}
		a.fragments[key] = fragment
	}
	packet := input.Packet
	packet.Payload = append([]byte(nil), packet.Payload...)
	fragment.Packets = append(fragment.Packets, packet)
	a.contentBytes += len(packet.Payload)
	a.packetCount++
	a.trackEpochs[input.Track.TrackID] = input.Track.Epoch
	if a.durationLocked() >= a.cfg.TargetDurationMilliseconds {
		if err := a.closeLocked(CloseReasonCadence, a.endMono, a.endMedia); err != nil {
			return err
		}
	}
	return nil
}

func (a *Assembler) validateTrackBindingLocked(track TrackIdentity) error {
	identityKey := track.TrackID + "\x00" + fmt.Sprintf("%020d", track.Epoch)
	if previous, exists := a.trackBindings[identityKey]; exists && previous != track {
		return ErrTrackIdentityMutation
	}
	if previousEpoch, exists := a.trackEpochs[track.TrackID]; exists && previousEpoch != track.Epoch {
		return ErrTrackEpochChangeNeeded
	}
	a.trackBindings[identityKey] = track
	return nil
}

func (a *Assembler) validateDurationLocked(monotonic, media int64) error {
	if !a.hasTime {
		return nil
	}
	startMono := a.startMono
	endMono := a.endMono
	if monotonic < startMono {
		startMono = monotonic
	}
	if monotonic > endMono {
		endMono = monotonic
	}
	startMedia := a.startMedia
	endMedia := a.endMedia
	if media < startMedia {
		startMedia = media
	}
	if media > endMedia {
		endMedia = media
	}
	if endMono-startMono > a.cfg.MaxDurationMilliseconds || endMedia-startMedia > a.cfg.MaxDurationMilliseconds {
		return ErrDurationLimit
	}
	return nil
}

func (a *Assembler) touchTimeLocked(monotonic, media int64) {
	if !a.hasTime {
		a.hasTime = true
		a.startMono, a.endMono = monotonic, monotonic
		a.startMedia, a.endMedia = media, media
		return
	}
	if monotonic < a.startMono {
		a.startMono = monotonic
	}
	if monotonic > a.endMono {
		a.endMono = monotonic
	}
	if media < a.startMedia {
		a.startMedia = media
	}
	if media > a.endMedia {
		a.endMedia = media
	}
}

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
		Version: Version,
		Manifest: Manifest{
			Version:                Version,
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

func (a *Assembler) checkOpenLocked() error {
	if !a.closed {
		return nil
	}
	if a.closeErr != nil {
		return a.closeErr
	}
	return ErrAssemblerClosed
}

func (a *Assembler) durationLocked() int64 {
	if !a.hasTime {
		return 0
	}
	mono := a.endMono - a.startMono
	media := a.endMedia - a.startMedia
	if media > mono {
		return media
	}
	return mono
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
