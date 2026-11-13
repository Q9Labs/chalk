package recordingdecode

import (
	"context"
	"errors"
	"fmt"
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
	var pendingPacketLoss bool
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
		lost := started && (packet.ExtendedSequenceNumber != previousSequence+1 || packet.SSRC != previousSSRC)
		if len(packet.Payload) == 0 {
			// Empty RTP probes consume sequence numbers, not audio samples. Keep
			// the last audio end timestamp so DTX gaps still become silence.
			pendingPacketLoss = pendingPacketLoss || lost
			previousSequence, previousSSRC = packet.ExtendedSequenceNumber, packet.SSRC
			return nil
		}
		lost = lost || pendingPacketLoss
		samples, err := opusPacketSamples(packet.Payload)
		if err != nil {
			return fmt.Errorf("%w: Opus packet: %v", ErrDecode, err)
		}
		startTicks := uint64(packet.Timestamp)
		endTicks := startTicks + samples
		if endTicks < startTicks {
			return fmt.Errorf("%w: Opus timestamp overflow", ErrDecode)
		}
		newSegment := !started || lost || startTicks != previousEnd
		if started && startTicks < previousEnd {
			return fmt.Errorf("%w: overlapping Opus timestamps", ErrDecode)
		}
		if newSegment {
			if err := closeSegment(); err != nil {
				return err
			}
			if started && startTicks > previousEnd {
				reason := "source_gap"
				if lost {
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
		pendingPacketLoss = false
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
		return Source{}, nil, nil
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
