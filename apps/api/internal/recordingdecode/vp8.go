package recordingdecode

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
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

	a := vp8Assembler{
		segmentDirectory: segmentDirectory,
		state:            state, durationMS: durationMS, waitingForKeyFrame: true,
	}
	if err := a.read(ctx); err != nil {
		return Source{}, nil, err
	}
	if err := a.finish(); err != nil {
		return Source{}, nil, err
	}
	return a.render(ctx, runner, ffmpegPath, mediaDirectory, passthrough)
}

func (a *vp8Assembler) render(ctx context.Context, runner CommandRunner, ffmpegPath, mediaDirectory string, passthrough bool) (Source, []Discontinuity, error) {
	state, durationMS, segmentDirectory := a.state, a.durationMS, a.segmentDirectory
	segments, frameTimestamps, discontinuities := a.segments, a.frameTimestamps, a.resultDiscontinuities
	quality := &a.quality
	if len(segments) == 0 || len(frameTimestamps) == 0 {
		quality.result(state, nil, durationMS, nil)
		return Source{}, nil, nil
	}
	quality.result(state, frameTimestamps, durationMS, discontinuities)
	segments, frameTimestamps, discontinuities, err := usableVP8Segments(ctx, runner, ffmpegPath, segmentDirectory, segments, frameTimestamps, discontinuities, state, quality, durationMS)
	if err != nil {
		return Source{}, nil, err
	}
	discontinuities = declaredVideoLoss(state, frameTimestamps, durationMS, discontinuities)
	quality.result(state, frameTimestamps, durationMS, discontinuities)
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

	startTicks := frameTimestamps[0]
	frameTicks := quality.frameTicks(frameTimestamps)
	endTicks := vp8EndTicks(state, startTicks, frameTimestamps[len(frameTimestamps)-1]+frameTicks, durationMS, discontinuities)
	startMS, endMS := ticksToMillisecondsFloor(startTicks, videoClockRate), ticksToMillisecondsCeil(endTicks, videoClockRate)
	if endMS <= startMS {
		quality.result(state, nil, durationMS, nil)
		return Source{}, nil, nil
	}
	relativePath := filepath.Join("media", state.presentation.SourceID+".webm")
	outputPath := filepath.Join(mediaDirectory, state.presentation.SourceID+".webm")
	if err := writeVP8WebM(ctx, runner, ffmpegPath, mergedIVF, outputPath, vp8Timing{
		codecStartTicks: segments[0].startTicks, startTicks: startTicks, frameTicks: frameTicks,
		durationMS: endMS - startMS, frozen: state.degradation.FrozenMS > 0,
	}, passthrough); err != nil {
		return Source{}, nil, err
	}
	byteSize, checksum, err := fileFacts(outputPath)
	if err != nil {
		return Source{}, nil, fmt.Errorf("hash VP8 WebM: %w", err)
	}
	return sourceValue(state, "vp8", "webm", "video/webm", relativePath, startMS, endMS, byteSize, checksum), discontinuities, nil
}

func vp8EndTicks(state *sourceState, startTicks, endTicks uint64, durationMS int64, discontinuities []Discontinuity) uint64 {
	maximumTicks := uint64(durationMS) * videoClockRate / 1_000
	for _, gap := range discontinuities {
		if gap.EndMS == durationMS {
			endTicks = maximumTicks
			if state.hasSpan && state.spanEndMS > ticksToMillisecondsCeil(startTicks, videoClockRate) {
				endTicks = uint64(state.spanEndMS) * videoClockRate / 1000
			}
		}
	}
	return min(endTicks, maximumTicks)
}

type vp8Timing struct {
	codecStartTicks uint64
	startTicks      uint64
	frameTicks      uint64
	durationMS      int64
	frozen          bool
}

func writeVP8WebM(ctx context.Context, runner CommandRunner, ffmpegPath, mergedIVF, outputPath string, timing vp8Timing, passthrough bool) error {
	frameDuration := float64(timing.frameTicks) / float64(videoClockRate)
	sourceDuration := float64(timing.durationMS) / 1_000
	// Passthrough copies the recorded frames; the native compositor holds the
	// last frame itself. The browser renderer needs a re-encoded, padded file.
	encode := []string{"-c:v", "copy"}
	if !passthrough || timing.startTicks > timing.codecStartTicks {
		encode = []string{"-vf", "tpad=stop_mode=clone:stop_duration=" + strconv.FormatFloat(frameDuration, 'f', 6, 64),
			"-c:v", "libvpx", "-deadline", "good", "-cpu-used", "4", "-pix_fmt", "yuv420p", "-fps_mode", "vfr"}
	}
	if !passthrough && timing.frozen {
		encode = []string{"-vf", "tpad=stop_mode=clone:stop_duration=" + strconv.FormatFloat(sourceDuration, 'f', 6, 64) + ",fps=90000/" + strconv.FormatUint(timing.frameTicks, 10),
			"-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "4", "-threads", "1", "-pix_fmt", "yuv420p"}
	}
	args := []string{"-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-threads", "1", "-f", "ivf", "-i", mergedIVF}
	if timing.startTicks > timing.codecStartTicks {
		args = append(args, "-ss", strconv.FormatFloat(float64(timing.startTicks-timing.codecStartTicks)/float64(videoClockRate), 'f', 6, 64))
	}
	args = append(args, "-map", "0:v:0", "-an", "-t", strconv.FormatFloat(sourceDuration, 'f', 6, 64))
	args = append(args, encode...)
	return runFFmpeg(ctx, runner, ffmpegPath, append(args, "-f", "webm", outputPath)...)
}
