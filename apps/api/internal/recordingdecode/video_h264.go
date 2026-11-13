package recordingdecode

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/bluenviron/mediacommon/v2/pkg/codecs/h264"
	"github.com/bluenviron/mediacommon/v2/pkg/formats/mpegts"
	tscodecs "github.com/bluenviron/mediacommon/v2/pkg/formats/mpegts/codecs"
	"github.com/pion/webrtc/v4/pkg/media/h264writer"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

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

	timedPath := filepath.Join(segmentDirectory, "source.ts")
	timedFile, err := os.OpenFile(timedPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return Source{}, nil, fmt.Errorf("create H264 timed stream: %w", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, closeFileWithContext(timedFile, "close H264 timed stream"))
	}()
	track := &mpegts.Track{Codec: &tscodecs.H264{}}
	muxer := &mpegts.Writer{W: timedFile, Tracks: []*mpegts.Track{track}}
	if err := muxer.Initialize(); err != nil {
		return Source{}, nil, fmt.Errorf("initialize H264 timed stream: %w", err)
	}
	var frame bytes.Buffer
	var frameInputBytes int
	var frameTimestamps []uint64
	var writer *h264writer.H264Writer
	quality := vp8Quality{}
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
		frame.Reset()
		frameInputBytes = 0
		return nil
	}
	startSegment := func() {
		writer = h264writer.NewWith(&frame)
	}
	err = readSpool(state.spoolPath, func(packet recordingbundle.RTPPacket) error {
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
			startSegment()
			if lossStart > 0 && uint64(packet.Timestamp) > lossStart {
				resultDiscontinuities = append(resultDiscontinuities, sourceDiscontinuity(state,
					ticksToMillisecondsFloor(lossStart, videoClockRate), ticksToMillisecondsCeil(uint64(packet.Timestamp), videoClockRate), "packet_loss"))
			}
			waitingForKeyFrame = false
		}
		// Bound wire bytes before depacketization: FU-A fragments can accumulate
		// inside Pion even before they reach the access-unit buffer.
		if len(packet.Payload) > h264.MaxAccessUnitSize-frameInputBytes {
			return fmt.Errorf("%w: H264 access unit exceeds size bound", ErrDecode)
		}
		frameInputBytes += len(packet.Payload)
		rtpPacket := toRTPPacket(packet)
		if err := writer.WriteRTP(&rtpPacket); err != nil {
			return fmt.Errorf("%w: write H264 RTP: %v", ErrDecode, err)
		}
		if packet.Marker && frame.Len() > 0 {
			var au h264.AnnexB
			if err := au.Unmarshal(frame.Bytes()); err != nil {
				return fmt.Errorf("%w: parse H264 access unit: %v", ErrDecode, err)
			}
			timestamp := int64(packet.Timestamp)
			if err := muxer.WriteH264(track, timestamp, timestamp, au); err != nil {
				return fmt.Errorf("%w: mux H264 access unit: %v", ErrDecode, err)
			}
			frame.Reset()
			frameInputBytes = 0
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
	if len(frameTimestamps) == 0 {
		quality.result(state, nil, durationMS, nil)
		return Source{}, nil, nil
	}
	if waitingForKeyFrame {
		resultDiscontinuities = append(resultDiscontinuities, sourceDiscontinuity(state,
			ticksToMillisecondsFloor(lossStart, videoClockRate), durationMS, "packet_loss"))
	}
	resultDiscontinuities = declaredVideoLoss(state, frameTimestamps, durationMS, resultDiscontinuities)
	quality.result(state, frameTimestamps, durationMS, resultDiscontinuities)
	startTicks := frameTimestamps[0]
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
	if err := writeH264MP4(ctx, runner, ffmpegPath, timedPath, outputPath, nominalTicks, passthrough); err != nil {
		return Source{}, nil, err
	}
	byteSize, checksum, err := fileFacts(outputPath)
	if err != nil {
		return Source{}, nil, fmt.Errorf("hash H264 MP4: %w", err)
	}
	return sourceValue(state, "h264", "mp4", "video/mp4", relativePath, startMS, endMS, byteSize, checksum), resultDiscontinuities, nil
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

// writeH264MP4 preserves RTP timing carried by the MPEG-TS packets. Its command
// size and per-frame timing work do not grow with the number of timing changes.
func writeH264MP4(ctx context.Context, runner CommandRunner, ffmpegPath, timedPath, outputPath string, nominalTicks uint64, passthrough bool) error {
	args := []string{
		"-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-copyts", "-start_at_zero",
		"-f", "mpegts", "-i", timedPath, "-map", "0:v:0", "-an",
	}
	if passthrough {
		args = append(args, "-c:v", "copy", "-bsf:v", "setts=duration="+strconv.FormatUint(nominalTicks, 10))
	} else {
		args = append(args, "-fps_mode", "vfr", "-enc_time_base", "1:90000",
			"-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p")
	}
	args = append(args, "-movflags", "+faststart", "-video_track_timescale", "90000", outputPath)
	return runFFmpeg(ctx, runner, ffmpegPath, args...)
}
