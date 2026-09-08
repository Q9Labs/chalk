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

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

const opusClockRate uint64 = 48_000

type audioSegment struct {
	oggPath    string
	startTicks uint64
	endTicks   uint64
}

func decodeOpusSource(ctx context.Context, runner CommandRunner, ffmpegPath, workspace, mediaDirectory string, state *sourceState, durationMS int64) (result Source, resultDiscontinuities []Discontinuity, resultErr error) {
	if state.presentation.Kind != "microphone" {
		return Source{}, nil, fmt.Errorf("%w: Opus source is not a microphone", ErrDecode)
	}
	segmentDirectory := filepath.Join(workspace, ".audio-"+state.presentation.SourceID)
	if err := os.Mkdir(segmentDirectory, 0o700); err != nil {
		return Source{}, nil, fmt.Errorf("create Opus segment directory: %w", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, removeAllWithContext(segmentDirectory, "remove Opus segment workspace"))
	}()

	var segments []audioSegment
	var writer *oggwriter.OggWriter
	var current audioSegment
	var previousSequence uint64
	var previousEnd uint64
	var previousSSRC uint32
	var started bool
	closeSegment := func() error {
		if writer == nil {
			return nil
		}
		closing := writer
		writer = nil
		if err := closing.Close(); err != nil {
			return fmt.Errorf("close Opus segment: %w", err)
		}
		if err := patchOggPreSkip(current.oggPath); err != nil {
			return err
		}
		segments = append(segments, current)
		return nil
	}
	startSegment := func(packet recordingbundle.RTPPacket, endTicks uint64) error {
		current = audioSegment{
			oggPath:    filepath.Join(segmentDirectory, "segment-"+strconv.Itoa(len(segments))+".ogg"),
			startTicks: uint64(packet.Timestamp), endTicks: endTicks,
		}
		var err error
		writer, err = oggwriter.New(current.oggPath, uint32(opusClockRate), 1)
		if err != nil {
			return fmt.Errorf("create Opus segment: %w", err)
		}
		return nil
	}
	err := readSpool(state.spoolPath, func(packet recordingbundle.RTPPacket) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := validateMediaTimestamp(packet.Timestamp, opusClockRate, durationMS); err != nil {
			return err
		}
		samples, err := opusPacketSamples(packet.Payload)
		if err != nil {
			return fmt.Errorf("%w: Opus packet: %v", ErrDecode, err)
		}
		startTicks := uint64(packet.Timestamp)
		endTicks := startTicks + samples
		if endTicks < startTicks {
			return fmt.Errorf("%w: Opus timestamp overflow", ErrDecode)
		}
		newSegment := !started || packet.ExtendedSequenceNumber != previousSequence+1 || startTicks != previousEnd || packet.SSRC != previousSSRC
		if started && startTicks < previousEnd {
			return fmt.Errorf("%w: overlapping Opus timestamps", ErrDecode)
		}
		if newSegment {
			if err := closeSegment(); err != nil {
				return err
			}
			if started && startTicks > previousEnd {
				reason := "source_gap"
				if packet.ExtendedSequenceNumber != previousSequence+1 || packet.SSRC != previousSSRC {
					reason = "packet_loss"
				}
				resultDiscontinuities = append(resultDiscontinuities, sourceDiscontinuity(state,
					ticksToMillisecondsFloor(previousEnd, opusClockRate), ticksToMillisecondsCeil(startTicks, opusClockRate), reason))
			}
			if err := startSegment(packet, endTicks); err != nil {
				return err
			}
		}
		rtpPacket := rtp.Packet{Header: rtp.Header{
			Version: 2, SequenceNumber: packet.SequenceNumber, Timestamp: packet.Timestamp,
			SSRC: packet.SSRC, PayloadType: packet.PayloadType, Marker: packet.Marker,
		}, Payload: packet.Payload}
		if err := writer.WriteRTP(&rtpPacket); err != nil {
			return fmt.Errorf("%w: write Opus RTP: %v", ErrDecode, err)
		}
		current.endTicks = endTicks
		previousSequence, previousEnd, previousSSRC = packet.ExtendedSequenceNumber, endTicks, packet.SSRC
		started = true
		return nil
	})
	if err != nil {
		if writer != nil {
			closing := writer
			writer = nil
			if closeErr := closing.Close(); closeErr != nil {
				err = errors.Join(err, fmt.Errorf("close Opus segment after decode failure: %w", closeErr))
			}
		}
		return Source{}, nil, err
	}
	if err := closeSegment(); err != nil {
		return Source{}, nil, err
	}
	if len(segments) == 0 {
		return Source{}, nil, fmt.Errorf("%w: microphone source has no decodable packets", ErrDecode)
	}

	startMS := ticksToMillisecondsFloor(segments[0].startTicks, opusClockRate)
	endMS := ticksToMillisecondsCeil(segments[len(segments)-1].endTicks, opusClockRate)
	if endMS > durationMS {
		endMS = durationMS
	}
	if endMS <= startMS {
		return Source{}, nil, fmt.Errorf("%w: microphone interval is empty", ErrDecode)
	}
	relativePath := filepath.Join("media", state.presentation.SourceID+".wav")
	outputPath := filepath.Join(mediaDirectory, state.presentation.SourceID+".wav")
	samplesPerChannel := (endMS - startMS) * int64(opusClockRate) / 1_000
	if err := createSilentWAV(outputPath, int(opusClockRate), 1, samplesPerChannel); err != nil {
		return Source{}, nil, err
	}
	output, err := os.OpenFile(outputPath, os.O_RDWR, 0)
	if err != nil {
		return Source{}, nil, fmt.Errorf("open microphone WAV: %w", err)
	}
	closeOutput := func() error {
		if output == nil {
			return nil
		}
		closing := output
		output = nil
		return closeFileWithContext(closing, "close microphone WAV")
	}
	defer func() {
		resultErr = errors.Join(resultErr, closeOutput())
	}()
	for index, segment := range segments {
		pcmPath := filepath.Join(segmentDirectory, "segment-"+strconv.Itoa(index)+".pcm")
		if err := runFFmpeg(ctx, runner, ffmpegPath,
			"-hide_banner", "-nostdin", "-y", "-loglevel", "error",
			"-i", segment.oggPath, "-map", "0:a:0", "-ac", "1", "-ar", "48000",
			"-c:a", "pcm_s16le", "-f", "s16le", pcmPath,
		); err != nil {
			return Source{}, nil, err
		}
		segmentStartMS := ticksToMillisecondsFloor(segment.startTicks, opusClockRate)
		offsetSamples := int64(segment.startTicks) - startMS*int64(opusClockRate)/1_000
		maximumSamples := int64(segment.endTicks - segment.startTicks)
		if segmentStartMS >= endMS || offsetSamples >= samplesPerChannel {
			continue
		}
		if maximum := samplesPerChannel - offsetSamples; maximumSamples > maximum {
			maximumSamples = maximum
		}
		if err := copyPCM(output, pcmPath, wavHeaderBytes+offsetSamples*2, maximumSamples*2); err != nil {
			return Source{}, nil, err
		}
	}
	if err := output.Sync(); err != nil {
		return Source{}, nil, fmt.Errorf("sync microphone WAV: %w", err)
	}
	if err := closeOutput(); err != nil {
		return Source{}, nil, err
	}
	byteSize, checksum, err := fileFacts(outputPath)
	if err != nil {
		return Source{}, nil, fmt.Errorf("hash microphone WAV: %w", err)
	}
	source := sourceValue(state, "pcm_s16le", "wav", "audio/wav", relativePath, startMS, endMS, byteSize, checksum)
	sampleRate, channels := int(opusClockRate), 1
	source.SampleRateHz, source.Channels = &sampleRate, &channels
	return source, resultDiscontinuities, nil
}

func copyPCM(output *os.File, inputPath string, outputOffset, maximumBytes int64) (resultErr error) {
	input, err := os.Open(inputPath)
	if err != nil {
		return fmt.Errorf("open decoded PCM: %w", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, closeFileWithContext(input, "close decoded PCM"))
	}()
	info, err := input.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size()%2 != 0 {
		return fmt.Errorf("%w: decoded PCM is invalid", ErrDecode)
	}
	copyBytes := info.Size()
	if copyBytes > maximumBytes {
		copyBytes = maximumBytes
	}
	section := io.NewOffsetWriter(output, outputOffset)
	if copied, err := io.CopyN(section, input, copyBytes); err != nil || copied != copyBytes {
		return fmt.Errorf("copy decoded PCM: %w", err)
	}
	return nil
}

func opusPacketSamples(payload []byte) (uint64, error) {
	if len(payload) == 0 {
		return 0, errors.New("empty payload")
	}
	configuration := payload[0] >> 3
	var samplesPerFrame uint64
	switch {
	case configuration < 12:
		samplesPerFrame = []uint64{480, 960, 1_920, 2_880}[configuration%4]
	case configuration < 16:
		samplesPerFrame = []uint64{480, 960}[configuration%2]
	default:
		samplesPerFrame = []uint64{120, 240, 480, 960}[configuration%4]
	}
	var frameCount uint64
	switch payload[0] & 0x03 {
	case 0:
		frameCount = 1
	case 1, 2:
		frameCount = 2
	case 3:
		if len(payload) < 2 {
			return 0, errors.New("missing frame count")
		}
		frameCount = uint64(payload[1] & 0x3f)
		if frameCount == 0 {
			return 0, errors.New("zero frame count")
		}
	}
	samples := samplesPerFrame * frameCount
	if samples == 0 || samples > 5_760 {
		return 0, errors.New("packet exceeds 120 milliseconds")
	}
	return samples, nil
}

func patchOggPreSkip(path string) (resultErr error) {
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("open Ogg header: %w", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, closeFileWithContext(file, "close Ogg header"))
	}()
	var fixedHeader [27]byte
	if _, err := io.ReadFull(file, fixedHeader[:]); err != nil || string(fixedHeader[0:4]) != "OggS" {
		return fmt.Errorf("%w: invalid Ogg header", ErrDecode)
	}
	segmentCount := int(fixedHeader[26])
	segmentTable := make([]byte, segmentCount)
	if _, err := io.ReadFull(file, segmentTable); err != nil {
		return fmt.Errorf("%w: invalid Ogg segment table", ErrDecode)
	}
	payloadBytes := 0
	for _, size := range segmentTable {
		payloadBytes += int(size)
	}
	page := make([]byte, 27+segmentCount+payloadBytes)
	copy(page, fixedHeader[:])
	copy(page[27:], segmentTable)
	if _, err := io.ReadFull(file, page[27+segmentCount:]); err != nil {
		return fmt.Errorf("%w: invalid Ogg ID page", ErrDecode)
	}
	payloadOffset := 27 + segmentCount
	if payloadBytes < 19 || string(page[payloadOffset:payloadOffset+8]) != "OpusHead" {
		return fmt.Errorf("%w: missing Ogg OpusHead", ErrDecode)
	}
	binary.LittleEndian.PutUint16(page[payloadOffset+10:payloadOffset+12], 0)
	for index := 22; index < 26; index++ {
		page[index] = 0
	}
	binary.LittleEndian.PutUint32(page[22:26], oggCRC(page))
	if _, err := file.WriteAt(page, 0); err != nil {
		return fmt.Errorf("rewrite Ogg pre-skip: %w", err)
	}
	return nil
}

func oggCRC(value []byte) uint32 {
	var checksum uint32
	for _, octet := range value {
		checksum ^= uint32(octet) << 24
		for bit := 0; bit < 8; bit++ {
			if checksum&0x80000000 != 0 {
				checksum = (checksum << 1) ^ 0x04c11db7
			} else {
				checksum <<= 1
			}
		}
	}
	return checksum
}
