package recordingdecode

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4/pkg/media/ivfwriter"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

func decodeVP8Source(ctx context.Context, runner CommandRunner, ffmpegPath, workspace, mediaDirectory string, state *sourceState, durationMS int64, passthrough bool) (result Source, resultDiscontinuities []Discontinuity, resultErr error) {
	if !mediaKindIsVideo(state.presentation.Kind) {
		return Source{}, nil, fmt.Errorf("%w: VP8 source is not visual", ErrDecode)
	}
	segmentDirectory := filepath.Join(workspace, ".vp8-"+state.presentation.SourceID)
	if err := os.Mkdir(segmentDirectory, 0o700); err != nil {
		return Source{}, nil, fmt.Errorf("create VP8 segment directory: %w", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, removeAllWithContext(segmentDirectory, "remove VP8 segment workspace"))
	}()

	var segments []videoSegment
	var frameTimestamps []uint64
	var writer *ivfwriter.IVFWriter
	var current videoSegment
	var previousSequence uint64
	var previousSSRC uint32
	var previousTimestamp uint32
	var mediaStarted bool
	var started bool
	var quality vp8Quality
	var framePayload []byte
	var frameTimestamp uint32
	var frameKey bool
	var framePictureID vp8PictureID
	var previousPictureID vp8PictureID
	var frameWidth, frameHeight uint16
	var waitingForKeyFrame = true
	var lossStart uint64
	var recoveryPending bool
	closeSegment := func() error {
		if writer == nil {
			return nil
		}
		closing := writer
		writer = nil
		if err := closing.Close(); err != nil {
			return fmt.Errorf("close VP8 segment: %w", err)
		}
		segments = append(segments, current)
		return nil
	}
	startSegment := func(packet recordingbundle.RTPPacket, width, height uint16) error {
		if len(segments) > 0 && (current.width != width || current.height != height) {
			quality.dimensionSwitches++
		}
		current = videoSegment{
			path:       filepath.Join(segmentDirectory, "segment-"+strconv.Itoa(len(segments))+".ivf"),
			startTicks: uint64(packet.Timestamp), width: width, height: height,
		}
		var err error
		writer, err = ivfwriter.New(current.path,
			ivfwriter.WithCodec("video/VP8"), ivfwriter.WithWidthAndHeight(width, height),
			ivfwriter.WithFrameRate(1, uint32(videoClockRate)), ivfwriter.WithDirectPTS())
		if err != nil {
			return fmt.Errorf("create VP8 segment: %w", err)
		}
		return nil
	}
	beginRecovery := func(start uint64) error {
		if len(framePayload) > 0 {
			start = min(start, uint64(frameTimestamp))
			quality.drop(frameTimestamp)
			framePayload = nil
		}
		if !recoveryPending || start < lossStart {
			lossStart = start
		}
		recoveryPending = true
		waitingForKeyFrame = true
		return closeSegment()
	}
	deferredSequenceGap := false
	err := readVP8Pictures(ctx, state.spoolPath, durationMS, &quality, func(packet recordingbundle.RTPPacket) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if started && mediaStarted && len(packet.Payload) > 0 && packet.SSRC == previousSSRC && packet.ExtendedSequenceNumber <= previousSequence && packet.Timestamp <= previousTimestamp {
			quality.latePackets++
			return nil
		}
		sameSSRC := started && packet.SSRC == previousSSRC
		lost := deferredSequenceGap || started && (packet.ExtendedSequenceNumber != previousSequence+1 || !sameSSRC)
		deferredSequenceGap = lost
		previousSequence, previousSSRC, started = packet.ExtendedSequenceNumber, packet.SSRC, true
		// Classify stale media before it can abandon an in-progress live picture.
		// Its RTP sequence still contributes to transport gap detection.
		if len(packet.Payload) > 0 {
			if _, seen := quality.seen[packet.Timestamp]; seen {
				quality.duplicatePackets++
				return nil
			}
			if mediaStarted && packet.Timestamp < previousTimestamp {
				quality.latePackets++
				return nil
			}
		}
		beginPacketRecovery := func() error {
			start := uint64(packet.Timestamp)
			if len(frameTimestamps) > 0 {
				start = frameTimestamps[len(frameTimestamps)-1] + quality.frameTicks(frameTimestamps)
			}
			return beginRecovery(start)
		}
		if lost && (!sameSSRC || len(framePayload) > 0) {
			if err := beginPacketRecovery(); err != nil {
				return err
			}
			lost = false
			deferredSequenceGap = false
		}
		// Empty probes consume RTP sequence numbers, not codec or media clocks.
		if len(packet.Payload) == 0 {
			if lost {
				return beginPacketRecovery()
			}
			return nil
		}
		if err := validateMediaTimestamp(packet.Timestamp, videoClockRate, durationMS); err != nil {
			quality.malformedPackets++
			start := uint64(0)
			if len(framePayload) > 0 {
				start = uint64(frameTimestamp)
			} else {
				quality.drop(packet.Timestamp)
				if len(frameTimestamps) > 0 {
					start = frameTimestamps[len(frameTimestamps)-1] + quality.frameTicks(frameTimestamps)
				}
			}
			return beginRecovery(start)
		}
		if len(framePayload) > 0 && packet.Timestamp != frameTimestamp {
			if err := beginRecovery(uint64(frameTimestamp)); err != nil {
				return err
			}
		}
		var vp8 codecs.VP8Packet
		_, headerErr := vp8.Unmarshal(packet.Payload)
		if headerErr != nil || len(vp8.Payload) == 0 {
			quality.malformedPackets++
			quality.drop(packet.Timestamp)
			return beginRecovery(uint64(packet.Timestamp))
		}
		pictureID := vp8PictureIDFromPayload(vp8, packet.Payload)
		// Stale replay traffic can occupy RTP sequence numbers between two
		// complete pictures. Only bridge a frame boundary with independent codec
		// continuity and a normal frame interval; never bridge inside a frame.
		continuousPicture := lost && sameSSRC && !waitingForKeyFrame && len(framePayload) == 0 &&
			vp8.S == 1 && vp8.PID == 0 && pictureID.follows(previousPictureID) &&
			uint64(packet.Timestamp)-uint64(previousTimestamp) <= 2*quality.frameTicks(frameTimestamps)
		if lost && !continuousPicture {
			if err := beginPacketRecovery(); err != nil {
				return err
			}
		}
		deferredSequenceGap = false
		if len(framePayload) > 0 && vp8.S == 1 && vp8.PID == 0 {
			// A second start at the same timestamp is another copy of this frame,
			// not another lost frame. Decode the newest complete copy.
			quality.duplicatePackets++
			framePayload = nil
		}
		if len(framePayload) == 0 {
			if vp8.S != 1 || vp8.PID != 0 {
				if len(frameTimestamps) > 0 {
					quality.drop(packet.Timestamp)
				}
				return nil
			}
			var err error
			frameKey, frameWidth, frameHeight, err = vp8KeyFrame(packet.Payload)
			if err != nil {
				quality.malformedPackets++
				quality.drop(packet.Timestamp)
				return beginRecovery(uint64(packet.Timestamp))
			}
			if waitingForKeyFrame && !frameKey {
				if len(frameTimestamps) > 0 {
					quality.drop(packet.Timestamp)
				}
				return nil
			}
			frameTimestamp = packet.Timestamp
			framePictureID = pictureID
		}
		if len(framePayload)+len(vp8.Payload) > recordingbundle.MaxPacketPayloadBytes*1_024 {
			return fmt.Errorf("%w: VP8 frame exceeds size bound", ErrDecode)
		}
		framePayload = append(framePayload, vp8.Payload...)
		if !packet.Marker {
			return nil
		}
		if frameKey && writer != nil && (current.width != frameWidth || current.height != frameHeight) {
			if err := closeSegment(); err != nil {
				return err
			}
			waitingForKeyFrame = true
		}
		if waitingForKeyFrame {
			if err := startSegment(packet, frameWidth, frameHeight); err != nil {
				return err
			}
			if recoveryPending && uint64(packet.Timestamp) > lossStart {
				quality.recoveryTicks += uint64(packet.Timestamp) - lossStart
				resultDiscontinuities = append(resultDiscontinuities, sourceDiscontinuity(state, ticksToMillisecondsFloor(lossStart, videoClockRate), ticksToMillisecondsCeil(uint64(packet.Timestamp), videoClockRate), "packet_loss"))
			}
			recoveryPending = false
			waitingForKeyFrame = false
		}
		// Feed only complete frames to the codec writer; abandoned fragments must
		// never be joined to the next timestamp's frame.
		rtpPacket := toRTPPacket(packet)
		rtpPacket.Payload = append([]byte{0x10}, framePayload...)
		if err := writer.WriteRTP(&rtpPacket); err != nil {
			return fmt.Errorf("%w: write VP8 RTP: %v", ErrDecode, err)
		}
		previousTimestamp, mediaStarted = packet.Timestamp, true
		previousPictureID = framePictureID
		frameTimestamps = append(frameTimestamps, uint64(packet.Timestamp))
		quality.remember(packet.Timestamp)
		framePayload = nil
		return nil
	})
	if err != nil {
		if writer != nil {
			closing := writer
			writer = nil
			if closeErr := closing.Close(); closeErr != nil {
				err = errors.Join(err, fmt.Errorf("close VP8 segment after decode failure: %w", closeErr))
			}
		}
		return Source{}, nil, err
	}
	if len(framePayload) > 0 {
		start := uint64(frameTimestamp)
		if len(frameTimestamps) > 0 {
			start = min(start, frameTimestamps[len(frameTimestamps)-1]+quality.frameTicks(frameTimestamps))
		}
		if err := beginRecovery(start); err != nil {
			return Source{}, nil, err
		}
	}
	for _, gap := range quality.selectionLosses {
		resultDiscontinuities = append(resultDiscontinuities, sourceDiscontinuity(state, ticksToMillisecondsFloor(gap.start, videoClockRate), ticksToMillisecondsCeil(gap.end, videoClockRate), "packet_loss"))
	}
	if quality.selectionTail && len(frameTimestamps) > 0 {
		if err := beginRecovery(frameTimestamps[len(frameTimestamps)-1] + quality.frameTicks(frameTimestamps)); err != nil {
			return Source{}, nil, err
		}
	}
	if err := closeSegment(); err != nil {
		return Source{}, nil, err
	}
	if recoveryPending && len(frameTimestamps) > 0 {
		resultDiscontinuities = append(resultDiscontinuities, sourceDiscontinuity(state, ticksToMillisecondsFloor(lossStart, videoClockRate), durationMS, "packet_loss"))
	}
	if len(segments) == 0 || len(frameTimestamps) == 0 {
		quality.result(state, nil, durationMS, nil)
		return Source{}, nil, nil
	}
	quality.result(state, frameTimestamps, durationMS, resultDiscontinuities)
	segments, frameTimestamps, resultDiscontinuities, err = usableVP8Segments(ctx, runner, ffmpegPath, segmentDirectory, segments, frameTimestamps, resultDiscontinuities, state, &quality, durationMS)
	if err != nil {
		return Source{}, nil, err
	}
	resultDiscontinuities = declaredVideoLoss(state, frameTimestamps, durationMS, resultDiscontinuities)
	quality.result(state, frameTimestamps, durationMS, resultDiscontinuities)
	if len(segments) == 0 {
		return Source{}, nil, nil
	}
	// Native composition scales decoded frames directly to their output tile.
	// Only the legacy encoder (or trimming invisible preroll) needs a fixed canvas.
	if !passthrough || frameTimestamps[0] > segments[0].startTicks {
		segments, err = normalizeVP8Segments(ctx, runner, ffmpegPath, segmentDirectory, segments)
		if err != nil {
			return Source{}, nil, err
		}
	}
	mergedIVF := filepath.Join(segmentDirectory, "source.ivf")
	if err := mergeIVF(mergedIVF, segments); err != nil {
		return Source{}, nil, err
	}
	codecStartTicks := segments[0].startTicks
	startTicks := frameTimestamps[0]
	endTicks := frameTimestamps[len(frameTimestamps)-1] + quality.frameTicks(frameTimestamps)
	maximumTicks := uint64(durationMS) * videoClockRate / 1_000
	for _, gap := range resultDiscontinuities {
		if gap.EndMS == durationMS {
			endTicks = maximumTicks
			if state.hasSpan && state.spanEndMS > ticksToMillisecondsCeil(startTicks, videoClockRate) {
				endTicks = uint64(state.spanEndMS) * videoClockRate / 1000
			}
		}
	}
	if endTicks > maximumTicks {
		endTicks = maximumTicks
	}
	startMS, endMS := ticksToMillisecondsFloor(startTicks, videoClockRate), ticksToMillisecondsCeil(endTicks, videoClockRate)
	if endMS <= startMS {
		quality.result(state, nil, durationMS, nil)
		return Source{}, nil, nil
	}
	relativePath := filepath.Join("media", state.presentation.SourceID+".webm")
	outputPath := filepath.Join(mediaDirectory, state.presentation.SourceID+".webm")
	frameDuration := float64(quality.frameTicks(frameTimestamps)) / float64(videoClockRate)
	sourceDuration := float64(endMS-startMS) / 1_000
	// Passthrough copies the recorded frames; the native compositor holds the
	// last frame itself. The browser renderer needs a re-encoded, padded file.
	encode := []string{"-c:v", "copy"}
	if !passthrough || startTicks > codecStartTicks {
		encode = []string{"-vf", "tpad=stop_mode=clone:stop_duration=" + strconv.FormatFloat(frameDuration, 'f', 6, 64),
			"-c:v", "libvpx", "-deadline", "good", "-cpu-used", "4", "-pix_fmt", "yuv420p", "-fps_mode", "vfr"}
	}
	if !passthrough && state.degradation.FrozenMS > 0 {
		encode = []string{"-vf", "tpad=stop_mode=clone:stop_duration=" + strconv.FormatFloat(sourceDuration, 'f', 6, 64) + ",fps=90000/" + strconv.FormatUint(quality.frameTicks(frameTimestamps), 10),
			"-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "4", "-threads", "1", "-pix_fmt", "yuv420p"}
	}
	args := []string{"-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-threads", "1", "-f", "ivf", "-i", mergedIVF}
	if startTicks > codecStartTicks {
		args = append(args, "-ss", strconv.FormatFloat(float64(startTicks-codecStartTicks)/float64(videoClockRate), 'f', 6, 64))
	}
	args = append(args, "-map", "0:v:0", "-an", "-t", strconv.FormatFloat(sourceDuration, 'f', 6, 64))
	args = append(args, encode...)
	if err := runFFmpeg(ctx, runner, ffmpegPath, append(args, "-f", "webm", outputPath)...); err != nil {
		return Source{}, nil, err
	}
	byteSize, checksum, err := fileFacts(outputPath)
	if err != nil {
		return Source{}, nil, fmt.Errorf("hash VP8 WebM: %w", err)
	}
	return sourceValue(state, "vp8", "webm", "video/webm", relativePath, startMS, endMS, byteSize, checksum), resultDiscontinuities, nil
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
