package recordingdecode

import (
	"fmt"
	"path/filepath"
	"strconv"

	"github.com/pion/webrtc/v4/pkg/media/ivfwriter"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

func (a *vp8Assembler) closeSegment() error {
	if a.writer == nil {
		return nil
	}
	closing := a.writer
	a.writer = nil
	if err := closing.Close(); err != nil {
		return fmt.Errorf("close VP8 segment: %w", err)
	}
	a.segments = append(a.segments, a.current)
	return nil
}

func (a *vp8Assembler) startSegment(packet recordingbundle.RTPPacket, width, height uint16) error {
	if len(a.segments) > 0 && (a.current.width != width || a.current.height != height) {
		a.quality.dimensionSwitches++
	}
	a.current = videoSegment{
		path:       filepath.Join(a.segmentDirectory, "segment-"+strconv.Itoa(len(a.segments))+".ivf"),
		startTicks: uint64(packet.Timestamp), width: width, height: height,
	}
	var err error
	a.writer, err = ivfwriter.New(a.current.path,
		ivfwriter.WithCodec("video/VP8"), ivfwriter.WithWidthAndHeight(width, height),
		ivfwriter.WithFrameRate(1, uint32(videoClockRate)), ivfwriter.WithDirectPTS())
	if err != nil {
		return fmt.Errorf("create VP8 segment: %w", err)
	}
	return nil
}

func (a *vp8Assembler) beginRecovery(start uint64) error {
	if len(a.framePayload) > 0 {
		start = min(start, uint64(a.frameTimestamp))
		a.quality.drop(a.frameTimestamp)
		a.framePayload = nil
	}
	if !a.recoveryPending || start < a.lossStart {
		a.lossStart = start
	}
	a.recoveryPending = true
	a.waitingForKeyFrame = true
	return a.closeSegment()
}

func (a *vp8Assembler) beginPacketRecovery(timestamp uint32) error {
	start := uint64(timestamp)
	if len(a.frameTimestamps) > 0 {
		start = a.frameTimestamps[len(a.frameTimestamps)-1] + a.quality.frameTicks(a.frameTimestamps)
	}
	return a.beginRecovery(start)
}

func (a *vp8Assembler) writeFrame(packet recordingbundle.RTPPacket) error {
	if a.frameKey && a.writer != nil && (a.current.width != a.frameWidth || a.current.height != a.frameHeight) {
		if err := a.closeSegment(); err != nil {
			return err
		}
		a.waitingForKeyFrame = true
	}
	if a.waitingForKeyFrame {
		if err := a.startSegment(packet, a.frameWidth, a.frameHeight); err != nil {
			return err
		}
		if a.recoveryPending && uint64(packet.Timestamp) > a.lossStart {
			a.quality.recoveryTicks += uint64(packet.Timestamp) - a.lossStart
			a.resultDiscontinuities = append(a.resultDiscontinuities, sourceDiscontinuity(a.state, ticksToMillisecondsFloor(a.lossStart, videoClockRate), ticksToMillisecondsCeil(uint64(packet.Timestamp), videoClockRate), "packet_loss"))
		}
		a.recoveryPending = false
		a.waitingForKeyFrame = false
	}
	// Feed only complete frames to the codec a.writer; abandoned fragments must
	// never be joined to the next timestamp's frame.
	rtpPacket := toRTPPacket(packet)
	rtpPacket.Payload = append([]byte{0x10}, a.framePayload...)
	if err := a.writer.WriteRTP(&rtpPacket); err != nil {
		return fmt.Errorf("%w: write VP8 RTP: %v", ErrDecode, err)
	}
	a.previousTimestamp, a.mediaStarted = packet.Timestamp, true
	a.previousPictureID = a.framePictureID
	a.frameTimestamps = append(a.frameTimestamps, uint64(packet.Timestamp))
	a.quality.remember(packet.Timestamp)
	a.framePayload = nil
	return nil
}

func (a *vp8Assembler) finish() error {
	if len(a.framePayload) > 0 {
		start := uint64(a.frameTimestamp)
		if len(a.frameTimestamps) > 0 {
			start = min(start, a.frameTimestamps[len(a.frameTimestamps)-1]+a.quality.frameTicks(a.frameTimestamps))
		}
		if err := a.beginRecovery(start); err != nil {
			return err
		}
	}
	for _, gap := range a.quality.selectionLosses {
		a.resultDiscontinuities = append(a.resultDiscontinuities, sourceDiscontinuity(a.state, ticksToMillisecondsFloor(gap.start, videoClockRate), ticksToMillisecondsCeil(gap.end, videoClockRate), "packet_loss"))
	}
	if a.quality.selectionTail && len(a.frameTimestamps) > 0 {
		if err := a.beginRecovery(a.frameTimestamps[len(a.frameTimestamps)-1] + a.quality.frameTicks(a.frameTimestamps)); err != nil {
			return err
		}
	}
	if err := a.closeSegment(); err != nil {
		return err
	}
	if a.recoveryPending && len(a.frameTimestamps) > 0 {
		a.resultDiscontinuities = append(a.resultDiscontinuities, sourceDiscontinuity(a.state, ticksToMillisecondsFloor(a.lossStart, videoClockRate), a.durationMS, "packet_loss"))
	}
	return nil
}
