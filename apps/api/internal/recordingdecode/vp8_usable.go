package recordingdecode

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

// Validate the codec, not just RTP assembly. Keep original bytes on the clean
// path; after a codec rejection, dependent pictures cannot recover before a key.
func usableVP8Segments(ctx context.Context, runner CommandRunner, ffmpeg, directory string, segments []videoSegment, timestamps []uint64, gaps []Discontinuity, state *sourceState, quality *vp8Quality, durationMS int64) ([]videoSegment, []uint64, []Discontinuity, error) {
	kept := make([]videoSegment, 0, len(segments))
	accepted := make([]uint64, 0, len(timestamps))
	nominal := nominalFrameTicks(timestamps)
	displayed := false
	var lossStart uint64
	pending := false
	for index, segment := range segments {
		crcPath := filepath.Join(directory, fmt.Sprintf("decoded-%d.crc", index))
		output, decodeErr := runner.Run(ctx, ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "fatal", "-threads", "1", "-err_detect", "explode", "-fflags", "+discardcorrupt", "-f", "ivf", "-i", segment.path, "-map", "0:v:0", "-an", "-enc_time_base", "1:90000", "-fps_mode", "passthrough", "-c:v", "wrapped_avframe", "-f", "framecrc", crcPath)
		if ctx.Err() != nil {
			return nil, nil, nil, ctx.Err()
		}
		if decodeErr != nil {
			var exit *exec.ExitError
			// FFmpeg uses 69 when decoding errors exceed its threshold. Every other
			// process failure (including missing binaries and cancellation) is fatal.
			if !errors.As(decodeErr, &exit) || exit.ExitCode() != 69 {
				return nil, nil, nil, fmt.Errorf("validate VP8 codec: %w: %.2048s", decodeErr, output)
			}
		}
		decoded, err := vp8DecodedTimestamps(crcPath)
		if err != nil {
			return nil, nil, nil, err
		}
		input, err := os.Open(segment.path)
		if err != nil {
			return nil, nil, nil, err
		}
		filteredPath := filepath.Join(directory, fmt.Sprintf("usable-%d.ivf", index))
		filtered, err := os.OpenFile(filteredPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return nil, nil, nil, errors.Join(err, input.Close())
		}
		var header [32]byte
		_, err = io.ReadFull(input, header[:])
		if err == nil {
			_, err = filtered.Write(header[:])
		}
		frames, changed, waiting := 0, false, false
		var firstLocal uint64
		for err == nil {
			var frameHeader [12]byte
			_, err = io.ReadFull(input, frameHeader[:])
			if errors.Is(err, io.EOF) {
				err = nil
				break
			}
			if err != nil {
				break
			}
			size := binary.LittleEndian.Uint32(frameHeader[:4])
			if size == 0 || size > recordingbundle.MaxPacketPayloadBytes*1024 {
				err = fmt.Errorf("%w: invalid VP8 frame size", ErrDecode)
				break
			}
			payload := make([]byte, size)
			_, err = io.ReadFull(input, payload)
			if err != nil {
				clear(payload)
				break
			}
			local := binary.LittleEndian.Uint64(frameHeader[4:])
			timestamp := local + segment.startTicks
			_, decodable := decoded[local]
			// show_frame=0 pictures update references without emitting a display frame
			// (RFC 6386 section 9.1). Their absence from framecrc is not corruption.
			headerBytes := 3
			if payload[0]&1 == 0 {
				headerBytes = 10
			}
			invisible := false
			if len(payload) >= headerBytes {
				firstPartition := uint32(payload[0])>>5 | uint32(payload[1])<<3 | uint32(payload[2])<<11
				invisible = payload[0]&0x10 == 0 && firstPartition > 0 && firstPartition <= uint32(len(payload)-headerBytes)
			}
			if !decodable && !invisible || waiting && payload[0]&1 != 0 {
				changed, waiting = true, true
				quality.droppedFrames++
				if !pending && len(accepted) > 0 {
					lossStart = accepted[len(accepted)-1] + nominal
					pending = true
				}
				clear(payload)
				continue
			}
			waiting = false
			if pending && decodable {
				gaps = append(gaps, sourceDiscontinuity(state, ticksToMillisecondsFloor(lossStart, videoClockRate), ticksToMillisecondsFloor(timestamp, videoClockRate), "packet_loss"))
				pending = false
			}
			if decodable {
				accepted = append(accepted, timestamp)
				displayed = true
			}
			if frames == 0 {
				firstLocal = local
			}
			binary.LittleEndian.PutUint64(frameHeader[4:], local-firstLocal)
			_, err = filtered.Write(frameHeader[:])
			if err == nil {
				_, err = filtered.Write(payload)
			}
			clear(payload)
			frames++
		}
		err = errors.Join(err, input.Close(), filtered.Close())
		if err != nil {
			return nil, nil, nil, fmt.Errorf("filter unusable VP8 pictures: %w", err)
		}
		if frames == 0 {
			continue
		}
		if changed {
			segment.path = filteredPath
			segment.startTicks += firstLocal
		}
		kept = append(kept, segment)
	}
	if !displayed {
		return nil, nil, gaps, nil
	}
	if pending {
		gaps = append(gaps, sourceDiscontinuity(state, ticksToMillisecondsFloor(lossStart, videoClockRate), durationMS, "packet_loss"))
	}
	return kept, accepted, normalizeDiscontinuities(gaps), nil
}

func vp8DecodedTimestamps(path string) (result map[uint64]struct{}, resultErr error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open VP8 codec validation: %w", err)
	}
	defer func() { resultErr = errors.Join(resultErr, file.Close()) }()
	result = make(map[uint64]struct{})
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "#") || strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.Split(line, ",")
		if len(fields) < 6 {
			return nil, fmt.Errorf("%w: invalid VP8 codec timestamp", ErrDecode)
		}
		timestamp, err := strconv.ParseUint(strings.TrimSpace(fields[2]), 10, 64)
		if err != nil {
			return nil, fmt.Errorf("parse VP8 codec timestamp: %w", err)
		}
		result[timestamp] = struct{}{}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read VP8 codec validation: %w", err)
	}
	return result, nil
}
