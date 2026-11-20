package recordingdecode

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"

	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4/pkg/media/ivfwriter"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

// vp8Assembler owns transport and frame state for one source spool.
type vp8Assembler struct {
	segmentDirectory      string
	state                 *sourceState
	durationMS            int64
	segments              []videoSegment
	frameTimestamps       []uint64
	writer                *ivfwriter.IVFWriter
	current               videoSegment
	previousSequence      uint64
	previousSSRC          uint32
	previousTimestamp     uint32
	mediaStarted          bool
	started               bool
	quality               vp8Quality
	framePayload          []byte
	frameTimestamp        uint32
	frameKey              bool
	framePictureID        vp8PictureID
	previousPictureID     vp8PictureID
	frameWidth            uint16
	frameHeight           uint16
	waitingForKeyFrame    bool
	lossStart             uint64
	recoveryPending       bool
	deferredSequenceGap   bool
	resultDiscontinuities []Discontinuity
}

func (a *vp8Assembler) read(ctx context.Context) error {
	err := readVP8Pictures(ctx, a.state.spoolPath, a.durationMS, &a.quality, func(packet recordingbundle.RTPPacket) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		return a.acceptPacket(packet)
	})
	if err != nil && a.writer != nil {
		closing := a.writer
		a.writer = nil
		if closeErr := closing.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close VP8 segment after decode failure: %w", closeErr))
		}
	}
	return err
}

func (a *vp8Assembler) acceptPacket(packet recordingbundle.RTPPacket) error {
	if a.replayedPacket(packet) {
		a.quality.latePackets++
		return nil
	}
	lost, sameSSRC := a.observeSequence(packet)
	// Classify stale media before it can abandon an in-progress live picture.
	// Its RTP sequence still contributes to transport gap detection.
	if a.staleMedia(packet) {
		return nil
	}
	if lost && (!sameSSRC || len(a.framePayload) > 0) {
		if err := a.beginPacketRecovery(packet.Timestamp); err != nil {
			return err
		}
		lost = false
		a.deferredSequenceGap = false
	}
	// Empty probes consume RTP sequence numbers, not codec or media clocks.
	if len(packet.Payload) == 0 {
		if lost {
			return a.beginPacketRecovery(packet.Timestamp)
		}
		return nil
	}

	vp8, ok, err := a.parseMediaPacket(packet)
	if err != nil || !ok {
		return err
	}
	pictureID := vp8PictureIDFromPayload(vp8, packet.Payload)
	if err := a.checkPictureContinuity(packet.Timestamp, vp8, pictureID, lost, sameSSRC); err != nil {
		return err
	}
	return a.appendPacket(packet, vp8, pictureID)
}

func (a *vp8Assembler) checkPictureContinuity(timestamp uint32, vp8 codecs.VP8Packet, pictureID vp8PictureID, lost, sameSSRC bool) error {
	if lost && !a.continuousPicture(timestamp, vp8, pictureID, sameSSRC) {
		if err := a.beginPacketRecovery(timestamp); err != nil {
			return err
		}
	}
	a.deferredSequenceGap = false
	return nil
}

func (a *vp8Assembler) observeSequence(packet recordingbundle.RTPPacket) (lost, sameSSRC bool) {
	sameSSRC = a.started && packet.SSRC == a.previousSSRC
	lost = a.deferredSequenceGap || a.started && (packet.ExtendedSequenceNumber != a.previousSequence+1 || !sameSSRC)
	a.deferredSequenceGap = lost
	a.previousSequence, a.previousSSRC, a.started = packet.ExtendedSequenceNumber, packet.SSRC, true
	return lost, sameSSRC
}

func (a *vp8Assembler) replayedPacket(packet recordingbundle.RTPPacket) bool {
	return a.started && a.mediaStarted && len(packet.Payload) > 0 && packet.SSRC == a.previousSSRC &&
		packet.ExtendedSequenceNumber <= a.previousSequence && packet.Timestamp <= a.previousTimestamp
}

func (a *vp8Assembler) staleMedia(packet recordingbundle.RTPPacket) bool {
	if len(packet.Payload) > 0 {
		if _, seen := a.quality.seen[packet.Timestamp]; seen {
			a.quality.duplicatePackets++
			return true
		}
		if a.mediaStarted && packet.Timestamp < a.previousTimestamp {
			a.quality.latePackets++
			return true
		}
	}
	return false
}

func (a *vp8Assembler) parseMediaPacket(packet recordingbundle.RTPPacket) (codecs.VP8Packet, bool, error) {
	if err := validateMediaTimestamp(packet.Timestamp, videoClockRate, a.durationMS); err != nil {
		a.quality.malformedPackets++
		start := uint64(0)
		if len(a.framePayload) > 0 {
			start = uint64(a.frameTimestamp)
		} else {
			a.quality.drop(packet.Timestamp)
			if len(a.frameTimestamps) > 0 {
				start = a.frameTimestamps[len(a.frameTimestamps)-1] + a.quality.frameTicks(a.frameTimestamps)
			}
		}
		return codecs.VP8Packet{}, false, a.beginRecovery(start)
	}
	if len(a.framePayload) > 0 && packet.Timestamp != a.frameTimestamp {
		if err := a.beginRecovery(uint64(a.frameTimestamp)); err != nil {
			return codecs.VP8Packet{}, false, err
		}
	}
	var vp8 codecs.VP8Packet
	_, headerErr := vp8.Unmarshal(packet.Payload)
	if headerErr != nil || len(vp8.Payload) == 0 {
		a.quality.malformedPackets++
		a.quality.drop(packet.Timestamp)
		return codecs.VP8Packet{}, false, a.beginRecovery(uint64(packet.Timestamp))
	}
	return vp8, true, nil
}

func (a *vp8Assembler) continuousPicture(timestamp uint32, vp8 codecs.VP8Packet, pictureID vp8PictureID, sameSSRC bool) bool {
	// Stale replay traffic can occupy RTP sequence numbers between two
	// complete pictures. Only bridge a frame boundary with independent codec
	// continuity and a normal frame interval; never bridge inside a frame.
	return sameSSRC && !a.waitingForKeyFrame && len(a.framePayload) == 0 &&
		vp8.S == 1 && vp8.PID == 0 && pictureID.follows(a.previousPictureID) &&
		uint64(timestamp)-uint64(a.previousTimestamp) <= 2*a.quality.frameTicks(a.frameTimestamps)
}

func (a *vp8Assembler) appendPacket(packet recordingbundle.RTPPacket, vp8 codecs.VP8Packet, pictureID vp8PictureID) error {
	if len(a.framePayload) > 0 && vp8.S == 1 && vp8.PID == 0 {
		// A second start at the same timestamp is another copy of this frame,
		// not another lost frame. Decode the newest complete copy.
		a.quality.duplicatePackets++
		a.framePayload = nil
	}
	if len(a.framePayload) == 0 {
		ok, err := a.startFrame(packet, vp8, pictureID)
		if err != nil || !ok {
			return err
		}
	}
	if len(a.framePayload)+len(vp8.Payload) > recordingbundle.MaxPacketPayloadBytes*1_024 {
		return fmt.Errorf("%w: VP8 frame exceeds size bound", ErrDecode)
	}
	a.framePayload = append(a.framePayload, vp8.Payload...)
	if !packet.Marker {
		return nil
	}
	return a.writeFrame(packet)
}

func (a *vp8Assembler) startFrame(packet recordingbundle.RTPPacket, vp8 codecs.VP8Packet, pictureID vp8PictureID) (bool, error) {
	if vp8.S != 1 || vp8.PID != 0 {
		if len(a.frameTimestamps) > 0 {
			a.quality.drop(packet.Timestamp)
		}
		return false, nil
	}
	var err error
	a.frameKey, a.frameWidth, a.frameHeight, err = vp8KeyFrame(packet.Payload)
	if err != nil {
		a.quality.malformedPackets++
		a.quality.drop(packet.Timestamp)
		return false, a.beginRecovery(uint64(packet.Timestamp))
	}
	if a.waitingForKeyFrame && !a.frameKey {
		if len(a.frameTimestamps) > 0 {
			a.quality.drop(packet.Timestamp)
		}
		return false, nil
	}
	a.frameTimestamp = packet.Timestamp
	a.framePictureID = pictureID
	return true, nil
}

func vp8KeyFrame(payload []byte) (bool, uint16, uint16, error) {
	packet := codecs.VP8Packet{}
	if _, err := packet.Unmarshal(payload); err != nil {
		return false, 0, 0, fmt.Errorf("%w: VP8 payload: %v", ErrDecode, err)
	}
	if packet.S != 1 || packet.PID != 0 || len(packet.Payload) == 0 || packet.Payload[0]&0x01 != 0 {
		return false, 0, 0, nil
	}
	if len(packet.Payload) < 10 || packet.Payload[3] != 0x9d || packet.Payload[4] != 0x01 || packet.Payload[5] != 0x2a {
		return false, 0, 0, fmt.Errorf("%w: VP8 key frame header is invalid", ErrDecode)
	}
	width := binary.LittleEndian.Uint16(packet.Payload[6:8]) & 0x3fff
	height := binary.LittleEndian.Uint16(packet.Payload[8:10]) & 0x3fff
	if width == 0 || height == 0 || width > 8_192 || height > 8_192 {
		return false, 0, 0, fmt.Errorf("%w: VP8 dimensions are invalid", ErrDecode)
	}
	return true, width, height, nil
}
