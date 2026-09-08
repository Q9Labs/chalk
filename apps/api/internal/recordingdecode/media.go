package recordingdecode

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

func decodeSource(ctx context.Context, runner CommandRunner, ffmpegPath, workspace, mediaDirectory string, state *sourceState, durationMS int64) (Source, []Discontinuity, error) {
	switch strings.ToLower(state.track.Codec) {
	case "opus":
		return decodeOpusSource(ctx, runner, ffmpegPath, workspace, mediaDirectory, state, durationMS)
	case "vp8":
		return decodeVP8Source(ctx, runner, ffmpegPath, workspace, mediaDirectory, state, durationMS)
	case "h264":
		return decodeH264Source(ctx, runner, ffmpegPath, workspace, mediaDirectory, state, durationMS)
	default:
		return Source{}, nil, fmt.Errorf("%w: unsupported codec %q", ErrDecode, state.track.Codec)
	}
}

func sourceValue(state *sourceState, codec, container, contentType, relativePath string, startMS, endMS, byteSize int64, checksum string) Source {
	return Source{
		SourceID: state.presentation.SourceID, ParticipantID: state.presentation.ParticipantID,
		ParticipantGeneration: state.presentation.ParticipantGeneration,
		TrackID:               state.presentation.TrackID, TrackEpoch: state.presentation.Epoch,
		Kind: string(state.presentation.Kind), Codec: codec, Container: container,
		ContentType: contentType, Path: filepath.ToSlash(relativePath), ByteSize: byteSize,
		SHA256: checksum, StartMS: startMS, EndMS: endMS,
	}
}

func sourceDiscontinuity(state *sourceState, startMS, endMS int64, reason string) Discontinuity {
	return Discontinuity{
		SourceID: state.presentation.SourceID, TrackID: state.presentation.TrackID,
		TrackEpoch: state.presentation.Epoch, StartMS: startMS, EndMS: endMS, Reason: reason,
	}
}

func readSpool(path string, visit func(recordingbundle.RTPPacket) error) (resultErr error) {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open RTP spool: %w", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, closeFileWithContext(file, "close RTP spool"))
	}()
	reader := bufio.NewReaderSize(file, 64<<10)
	for {
		packet, err := readSpoolPacket(reader)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read RTP spool: %w", err)
		}
		if err := visit(packet); err != nil {
			clear(packet.Payload)
			return err
		}
		clear(packet.Payload)
	}
}

func validateMediaTimestamp(timestamp uint32, rate uint64, durationMS int64) error {
	maximum := uint64(durationMS) * rate / 1_000
	if uint64(timestamp) > maximum {
		return fmt.Errorf("%w: RTP timestamp exceeds presentation duration", ErrInvalidBundle)
	}
	return nil
}

func mediaKindIsVideo(kind recordingpresentation.MediaKind) bool {
	return kind == recordingpresentation.MediaKindCamera || kind == recordingpresentation.MediaKindScreenShare
}
