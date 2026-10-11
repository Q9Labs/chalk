package recordingdecode

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4/pkg/media/h264writer"
	"github.com/pion/webrtc/v4/pkg/media/ivfwriter"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

const videoClockRate uint64 = 90_000

const vp8ReplayWindow = 1_024

type videoSegment struct {
	path       string
	startTicks uint64
	width      uint16
	height     uint16
}

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

func decodeH264Source(ctx context.Context, runner CommandRunner, ffmpegPath, workspace, mediaDirectory string, state *sourceState, durationMS int64, passthrough bool) (result Source, resultDiscontinuities []Discontinuity, resultErr error) {
	if !mediaKindIsVideo(state.presentation.Kind) {
		return Source{}, nil, fmt.Errorf("%w: H264 source is not visual", ErrDecode)
	}
	segmentDirectory := filepath.Join(workspace, ".h264-"+state.presentation.SourceID)
	if err := os.Mkdir(segmentDirectory, 0o700); err != nil {
		return Source{}, nil, fmt.Errorf("create H264 segment directory: %w", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, removeAllWithContext(segmentDirectory, "remove H264 segment workspace"))
	}()

	var segments []videoSegment
	var frameTimestamps []uint64
	var writer *h264writer.H264Writer
	quality := vp8Quality{}
	var current videoSegment
	var previousSequence uint64
	var previousSSRC uint32
	var previousTimestamp uint32
	var started bool
	var waitingForKeyFrame = true
	var lossStart uint64
	closeSegment := func() error {
		if writer == nil {
			return nil
		}
		closing := writer
		writer = nil
		if err := closing.Close(); err != nil {
			return fmt.Errorf("close H264 segment: %w", err)
		}
		segments = append(segments, current)
		return nil
	}
	startSegment := func(packet recordingbundle.RTPPacket) error {
		current = videoSegment{path: filepath.Join(segmentDirectory, "segment-"+strconv.Itoa(len(segments))+".h264"), startTicks: uint64(packet.Timestamp)}
		var err error
		writer, err = h264writer.New(current.path)
		if err != nil {
			return fmt.Errorf("create H264 segment: %w", err)
		}
		return nil
	}
	err := readSpool(state.spoolPath, func(packet recordingbundle.RTPPacket) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := validateMediaTimestamp(packet.Timestamp, videoClockRate, durationMS); err != nil {
			return err
		}
		if started && packet.Timestamp < previousTimestamp {
			return fmt.Errorf("%w: H264 timestamp regressed", ErrDecode)
		}
		lost := started && (packet.ExtendedSequenceNumber != previousSequence+1 || packet.SSRC != previousSSRC)
		if lost {
			if err := closeSegment(); err != nil {
				return err
			}
			waitingForKeyFrame = true
			if len(frameTimestamps) > 0 {
				lossStart = frameTimestamps[len(frameTimestamps)-1] + nominalFrameTicks(frameTimestamps)
			} else {
				lossStart = uint64(packet.Timestamp)
			}
		}
		if waitingForKeyFrame {
			if !h264StartsKeyFrame(packet.Payload) {
				if started && packet.Marker {
					quality.drop(packet.Timestamp)
				}
				previousSequence, previousSSRC, previousTimestamp = packet.ExtendedSequenceNumber, packet.SSRC, packet.Timestamp
				started = true
				return nil
			}
			if err := startSegment(packet); err != nil {
				return err
			}
			if lossStart > 0 && uint64(packet.Timestamp) > lossStart {
				resultDiscontinuities = append(resultDiscontinuities, sourceDiscontinuity(state,
					ticksToMillisecondsFloor(lossStart, videoClockRate), ticksToMillisecondsCeil(uint64(packet.Timestamp), videoClockRate), "packet_loss"))
			}
			waitingForKeyFrame = false
		}
		rtpPacket := toRTPPacket(packet)
		if err := writer.WriteRTP(&rtpPacket); err != nil {
			return fmt.Errorf("%w: write H264 RTP: %v", ErrDecode, err)
		}
		if packet.Marker {
			frameTimestamps = append(frameTimestamps, uint64(packet.Timestamp))
		}
		previousSequence, previousSSRC, previousTimestamp = packet.ExtendedSequenceNumber, packet.SSRC, packet.Timestamp
		started = true
		return nil
	})
	if err != nil {
		if writer != nil {
			closing := writer
			writer = nil
			if closeErr := closing.Close(); closeErr != nil {
				err = errors.Join(err, fmt.Errorf("close H264 segment after decode failure: %w", closeErr))
			}
		}
		return Source{}, nil, err
	}
	if err := closeSegment(); err != nil {
		return Source{}, nil, err
	}
	if len(segments) == 0 || len(frameTimestamps) == 0 {
		quality.result(state, nil, durationMS, nil)
		return Source{}, nil, nil
	}
	rawPath := filepath.Join(segmentDirectory, "source.h264")
	if waitingForKeyFrame {
		resultDiscontinuities = append(resultDiscontinuities, sourceDiscontinuity(state,
			ticksToMillisecondsFloor(lossStart, videoClockRate), durationMS, "packet_loss"))
	}
	resultDiscontinuities = declaredVideoLoss(state, frameTimestamps, durationMS, resultDiscontinuities)
	if err := concatenateFiles(rawPath, segments); err != nil {
		return Source{}, nil, err
	}
	quality.result(state, frameTimestamps, durationMS, resultDiscontinuities)
	startTicks := segments[0].startTicks
	nominalTicks := nominalFrameTicks(frameTimestamps)
	endTicks := frameTimestamps[len(frameTimestamps)-1] + nominalTicks
	maximumTicks := uint64(durationMS) * videoClockRate / 1_000
	for _, gap := range resultDiscontinuities {
		if gap.EndMS == durationMS {
			endTicks = maximumTicks
			if state.hasSpan {
				endTicks = uint64(state.spanEndMS) * videoClockRate / 1_000
			}
		}
	}
	if endTicks > maximumTicks {
		endTicks = maximumTicks
	}
	startMS, endMS := ticksToMillisecondsFloor(startTicks, videoClockRate), ticksToMillisecondsCeil(endTicks, videoClockRate)
	if endMS <= startMS {
		return Source{}, nil, fmt.Errorf("%w: H264 interval is empty", ErrDecode)
	}
	relativePath := filepath.Join("media", state.presentation.SourceID+".mp4")
	outputPath := filepath.Join(mediaDirectory, state.presentation.SourceID+".mp4")
	if err := writeH264MP4(ctx, runner, ffmpegPath, rawPath, outputPath, frameTimestamps, startTicks, nominalTicks, passthrough); err != nil {
		return Source{}, nil, err
	}
	byteSize, checksum, err := fileFacts(outputPath)
	if err != nil {
		return Source{}, nil, fmt.Errorf("hash H264 MP4: %w", err)
	}
	return sourceValue(state, "h264", "mp4", "video/mp4", relativePath, startMS, endMS, byteSize, checksum), resultDiscontinuities, nil
}

func toRTPPacket(packet recordingbundle.RTPPacket) rtp.Packet {
	return rtp.Packet{Header: rtp.Header{
		Version: 2, SequenceNumber: packet.SequenceNumber, Timestamp: packet.Timestamp,
		SSRC: packet.SSRC, PayloadType: packet.PayloadType, Marker: packet.Marker,
	}, Payload: packet.Payload}
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

func h264StartsKeyFrame(payload []byte) bool {
	if len(payload) == 0 {
		return false
	}
	nalType := payload[0] & 0x1f
	switch nalType {
	case 7:
		return true
	case 24:
		for offset := 1; offset+2 <= len(payload); {
			size := int(binary.BigEndian.Uint16(payload[offset : offset+2]))
			offset += 2
			if size <= 0 || offset+size > len(payload) {
				return false
			}
			if payload[offset]&0x1f == 7 {
				return true
			}
			offset += size
		}
	case 28:
		return len(payload) >= 2 && payload[1]&0x80 != 0 && payload[1]&0x1f == 7
	}
	return false
}

func nominalFrameTicks(timestamps []uint64) uint64 {
	counts := make(map[uint64]int)
	var selected uint64 = 3_000
	selectedCount := 0
	for index := 1; index < len(timestamps); index++ {
		delta := timestamps[index] - timestamps[index-1]
		if delta == 0 || delta > videoClockRate {
			continue
		}
		counts[delta]++
		if counts[delta] > selectedCount || (counts[delta] == selectedCount && delta < selected) {
			selected, selectedCount = delta, counts[delta]
		}
	}
	return selected
}

func mergeIVF(outputPath string, segments []videoSegment) (resultErr error) {
	if len(segments) == 0 {
		return fmt.Errorf("%w: no IVF segments", ErrDecode)
	}
	output, err := os.OpenFile(outputPath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("create merged IVF: %w", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, closeFileWithContext(output, "close merged IVF"))
	}()
	var outputHeader [32]byte
	var frameCount uint64
	for index, segment := range segments {
		input, err := os.Open(segment.path)
		if err != nil {
			return fmt.Errorf("open IVF segment: %w", err)
		}
		var header [32]byte
		if _, err := io.ReadFull(input, header[:]); err != nil || string(header[0:4]) != "DKIF" || string(header[8:12]) != "VP80" {
			return errors.Join(fmt.Errorf("%w: invalid IVF segment", ErrDecode), closeFileWithContext(input, "close IVF segment"))
		}
		if index == 0 {
			outputHeader = header
			if _, err := output.Write(outputHeader[:]); err != nil {
				return errors.Join(fmt.Errorf("write IVF header: %w", err), closeFileWithContext(input, "close IVF segment"))
			}
		}
		for {
			var frameHeader [12]byte
			_, err := io.ReadFull(input, frameHeader[:])
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return errors.Join(fmt.Errorf("%w: truncated IVF frame header", ErrDecode), closeFileWithContext(input, "close IVF segment"))
			}
			frameSize := binary.LittleEndian.Uint32(frameHeader[0:4])
			if frameSize == 0 || frameSize > recordingbundle.MaxPacketPayloadBytes*1_024 {
				return errors.Join(fmt.Errorf("%w: invalid IVF frame size", ErrDecode), closeFileWithContext(input, "close IVF segment"))
			}
			pts := binary.LittleEndian.Uint64(frameHeader[4:12]) + segment.startTicks - segments[0].startTicks
			binary.LittleEndian.PutUint64(frameHeader[4:12], pts)
			if _, err := output.Write(frameHeader[:]); err != nil {
				return errors.Join(fmt.Errorf("write IVF frame header: %w", err), closeFileWithContext(input, "close IVF segment"))
			}
			if _, err := io.CopyN(output, input, int64(frameSize)); err != nil {
				return errors.Join(fmt.Errorf("copy IVF frame: %w", err), closeFileWithContext(input, "close IVF segment"))
			}
			frameCount++
		}
		if err := closeFileWithContext(input, "close IVF segment"); err != nil {
			return err
		}
	}
	if frameCount == 0 || frameCount > uint64(^uint32(0)) {
		return fmt.Errorf("%w: invalid IVF frame count", ErrDecode)
	}
	binary.LittleEndian.PutUint32(outputHeader[24:28], uint32(frameCount))
	if _, err := output.WriteAt(outputHeader[:], 0); err != nil {
		return fmt.Errorf("finalize IVF header: %w", err)
	}
	return nil
}

func concatenateFiles(outputPath string, segments []videoSegment) (resultErr error) {
	output, err := os.OpenFile(outputPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("create H264 stream: %w", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, closeFileWithContext(output, "close H264 stream"))
	}()
	for _, segment := range segments {
		input, err := os.Open(segment.path)
		if err != nil {
			return fmt.Errorf("open H264 segment: %w", err)
		}
		_, copyErr := io.Copy(output, input)
		closeErr := input.Close()
		if err := errors.Join(copyErr, closeErr); err != nil {
			return fmt.Errorf("copy H264 segment: %w", err)
		}
	}
	return nil
}

type h264TimingAdjustment struct {
	frame      int
	difference int64
}

// h264TimingAdjustments lists where frame timing departs from the nominal
// frame spacing, as tick offsets that apply from that frame on.
func h264TimingAdjustments(timestamps []uint64, startTicks, nominalTicks uint64) ([]h264TimingAdjustment, error) {
	if len(timestamps) == 0 || nominalTicks == 0 {
		return nil, fmt.Errorf("%w: missing H264 frame timestamps", ErrDecode)
	}
	var adjustments []h264TimingAdjustment
	for index := 1; index < len(timestamps); index++ {
		nominalTimestamp := startTicks + uint64(index)*nominalTicks
		actualTimestamp := timestamps[index]
		previousNominalTimestamp := startTicks + uint64(index-1)*nominalTicks
		previousActualTimestamp := timestamps[index-1]
		nominalDelta := nominalTimestamp - previousNominalTimestamp
		actualDelta := actualTimestamp - previousActualTimestamp
		if actualDelta == nominalDelta {
			continue
		}
		if len(adjustments) == 512 {
			return nil, fmt.Errorf("%w: H264 variable frame timing exceeds bound", ErrDecode)
		}
		adjustments = append(adjustments, h264TimingAdjustment{frame: index, difference: int64(actualDelta) - int64(nominalDelta)})
	}
	return adjustments, nil
}

// h264SetPTS is the setpts filter expression for re-encoding.
func h264SetPTS(timestamps []uint64, startTicks, nominalTicks uint64) (string, error) {
	adjustments, err := h264TimingAdjustments(timestamps, startTicks, nominalTicks)
	if err != nil {
		return "", err
	}
	var expression strings.Builder
	expression.WriteString("(N*")
	expression.WriteString(strconv.FormatUint(nominalTicks, 10))
	expression.WriteString("/90000)/TB")
	for _, adjustment := range adjustments {
		expression.WriteString("+if(gte(N,")
		expression.WriteString(strconv.Itoa(adjustment.frame))
		expression.WriteString("),")
		expression.WriteString(strconv.FormatInt(adjustment.difference, 10))
		expression.WriteString("/90000/TB,0)")
	}
	return expression.String(), nil
}

// h264SetTS is the setts bitstream filter expression, in 90 kHz ticks, for
// copying the stream as recorded. Commas are escaped for the filter list.
func h264SetTS(timestamps []uint64, startTicks, nominalTicks uint64) (string, error) {
	adjustments, err := h264TimingAdjustments(timestamps, startTicks, nominalTicks)
	if err != nil {
		return "", err
	}
	var expression strings.Builder
	expression.WriteString("N*")
	expression.WriteString(strconv.FormatUint(nominalTicks, 10))
	for _, adjustment := range adjustments {
		expression.WriteString(`+if(gte(N\,`)
		expression.WriteString(strconv.Itoa(adjustment.frame))
		expression.WriteString(`)\,`)
		expression.WriteString(strconv.FormatInt(adjustment.difference, 10))
		expression.WriteString(`\,0)`)
	}
	return expression.String(), nil
}

// writeH264MP4 times the raw stream from its RTP timestamps. Passthrough copies
// the recorded frames; otherwise they are re-encoded for browser seeking.
func writeH264MP4(ctx context.Context, runner CommandRunner, ffmpegPath, rawPath, outputPath string, frameTimestamps []uint64, startTicks, nominalTicks uint64, passthrough bool) error {
	if passthrough {
		timestamps, err := h264SetTS(frameTimestamps, startTicks, nominalTicks)
		if err != nil {
			return err
		}
		return runFFmpeg(ctx, runner, ffmpegPath,
			"-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-r", strconv.FormatUint(videoClockRate, 10),
			"-f", "h264", "-i", rawPath, "-map", "0:v:0", "-an", "-c:v", "copy", "-bsf:v", "setts=ts="+timestamps,
			"-movflags", "+faststart", "-video_track_timescale", "90000", outputPath,
		)
	}
	filter, err := h264SetPTS(frameTimestamps, startTicks, nominalTicks)
	if err != nil {
		return err
	}
	return runFFmpeg(ctx, runner, ffmpegPath,
		"-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-r", fmt.Sprintf("%d/%d", videoClockRate, nominalTicks),
		"-f", "h264", "-i", rawPath, "-map", "0:v:0", "-an", "-vf", "setpts="+filter,
		"-fps_mode", "vfr", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
		"-movflags", "+faststart", "-video_track_timescale", "90000", outputPath,
	)
}
