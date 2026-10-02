package recordingdecode

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

// TrackReplay inspects assembly through Render's shared decoder. It does not
// validate codec pixels or have the presentation's source-visibility spans.
type TrackReplay struct {
	TrackID           string         `json:"track_id"`
	Epoch             uint64         `json:"epoch"`
	Codec             string         `json:"codec"`
	Skipped           string         `json:"skipped,omitempty"`
	Packets           int            `json:"packets"`
	AssemblyOnly      bool           `json:"assembly_only"`
	AssembledFrames   int            `json:"assembled_frames"`
	DroppedFrames     int            `json:"dropped_frames"`
	FrozenMS          int64          `json:"frozen_ms"`
	Recoveries        int            `json:"recoveries"`
	DimensionSwitches int            `json:"dimension_switches"`
	PlaceholderMS     int64          `json:"placeholder_ms"`
	Failure           *ReplayFailure `json:"failure,omitempty"`
}

type ReplayFailure struct {
	Error string `json:"error"`
}

// ReplayVP8 shares spool merging, picture selection and recovery with Write.
// A runner inspects the assembled IVF files and stops before native codec
// validation. This also permits replay of pixel-free sanitized fixtures.
func ReplayVP8(ctx context.Context, fragments []recordingbundle.RTPFragment, durationMS int64) (results []TrackReplay, resultErr error) {
	if durationMS <= 0 {
		return nil, fmt.Errorf("%w: replay duration must be positive", ErrInvalidRequest)
	}
	workspace, err := os.MkdirTemp("", "chalk-bundle-replay-")
	if err != nil {
		return nil, fmt.Errorf("create replay workspace: %w", err)
	}
	defer func() { resultErr = errors.Join(resultErr, os.RemoveAll(workspace)) }()
	type trackKey struct {
		id    string
		epoch uint64
	}
	var order []trackKey
	states := map[trackKey]*sourceState{}
	for _, fragment := range fragments {
		key := trackKey{fragment.Track.TrackID, fragment.Track.Epoch}
		state := states[key]
		if state == nil {
			id := fmt.Sprintf("track-%d", len(order))
			state = &sourceState{track: fragment.Track, spoolPath: filepath.Join(workspace, id+".spool"), presentation: recordingpresentation.MediaSource{SourceID: id, Kind: recordingpresentation.MediaKindCamera}}
			states[key] = state
			order = append(order, key)
		}
		if strings.EqualFold(state.track.Codec, "vp8") {
			if err := appendFragmentRun(ctx, state, fragment, 0); err != nil {
				return nil, fmt.Errorf("track %s epoch %d: %w", key.id, key.epoch, err)
			}
		}
	}
	for _, key := range order {
		state := states[key]
		result := TrackReplay{TrackID: key.id, Epoch: key.epoch, Codec: state.track.Codec}
		if !strings.EqualFold(state.track.Codec, "vp8") {
			result.Skipped = "replay supports vp8 only"
			results = append(results, result)
			continue
		}
		if err := finalizeSourceSpool(ctx, state); err != nil {
			return nil, fmt.Errorf("track %s epoch %d: %w", key.id, key.epoch, err)
		}
		if err := readSpool(state.spoolPath, func(recordingbundle.RTPPacket) error { result.Packets++; return ctx.Err() }); err != nil {
			return nil, err
		}
		result.AssemblyOnly = true
		_, _, err := decodeVP8Source(ctx, &replayAssemblyRunner{result: &result}, "assembly-inspector", workspace, workspace, state, durationMS, true)
		if err != nil && !errors.Is(err, errReplayAssemblyComplete) {
			result.Failure = &ReplayFailure{Error: err.Error()}
		}
		result.DroppedFrames = state.degradation.DroppedFrames
		result.FrozenMS = state.degradation.FrozenMS
		result.Recoveries = state.degradation.Recoveries
		result.PlaceholderMS = state.degradation.PlaceholderMS
		results = append(results, result)
	}
	return results, nil
}

var errReplayAssemblyComplete = errors.New("replay inspected assembly before native codec validation")

type replayAssemblyRunner struct{ result *TrackReplay }

func (runner *replayAssemblyRunner) Run(ctx context.Context, _ string, args ...string) ([]byte, error) {
	var directory string
	for index, arg := range args {
		if arg == "-i" && index+1 < len(args) {
			directory = filepath.Dir(args[index+1])
			break
		}
	}
	if directory == "" {
		return nil, errors.New("replay inspector requires an IVF input")
	}
	var width, height uint16
	for index := 0; ; index++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		frames, w, h, err := inspectReplayIVF(filepath.Join(directory, fmt.Sprintf("segment-%d.ivf", index)))
		if errors.Is(err, os.ErrNotExist) {
			break
		}
		if err != nil {
			return nil, err
		}
		if index > 0 && (w != width || h != height) {
			runner.result.DimensionSwitches++
		}
		width, height = w, h
		runner.result.AssembledFrames += frames
	}
	return nil, errReplayAssemblyComplete
}

func inspectReplayIVF(path string) (frames int, width, height uint16, resultErr error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, 0, 0, err
	}
	defer func() { resultErr = errors.Join(resultErr, file.Close()) }()
	var header [32]byte
	if _, err := io.ReadFull(file, header[:]); err != nil {
		return 0, 0, 0, err
	}
	if string(header[:4]) != "DKIF" {
		return 0, 0, 0, errors.New("invalid assembled IVF header")
	}
	width, height = binary.LittleEndian.Uint16(header[12:14]), binary.LittleEndian.Uint16(header[14:16])
	for {
		var frame [12]byte
		_, err := io.ReadFull(file, frame[:])
		if errors.Is(err, io.EOF) {
			return frames, width, height, nil
		}
		if err != nil {
			return 0, 0, 0, err
		}
		if _, err := io.CopyN(io.Discard, file, int64(binary.LittleEndian.Uint32(frame[:4]))); err != nil {
			return 0, 0, 0, err
		}
		frames++
	}
}
