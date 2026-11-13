package recordingbundle

import (
	"errors"
	"fmt"
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
// assembler and returns ErrDurationLimit. Aggregate payload overflow seals
// the accepted packets and returns ErrAssemblerClosed for rotation.
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
	if len(input.Packet.Payload) > a.cfg.MaxContentBytes {
		return a.failLimitLocked(ErrContentLimit)
	}
	if a.contentBytes > a.cfg.MaxContentBytes-len(input.Packet.Payload) {
		// The rejected packet belongs in the next bundle. Keep the accepted
		// fragments sealable, including a keyframe split across this boundary.
		if err := a.closeLocked(CloseReasonLimitExceeded, a.endMono, a.endMedia); err != nil {
			return err
		}
		return ErrAssemblerClosed
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
