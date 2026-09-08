package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
)

type TranscriptionAudioPlan struct {
	InputPath     string   `json:"input_path"`
	OutputPath    string   `json:"output_path"`
	SourceStartMs int64    `json:"source_start_ms"`
	DurationMs    int64    `json:"duration_ms"`
	Codec         string   `json:"codec"`
	SampleRateHz  int      `json:"sample_rate_hz"`
	Channels      int      `json:"channels"`
	Command       []string `json:"command"`
}

func BuildTranscriptionAudioPlan(inputPath, outputPath string, sourceStartMillis, durationMillis int64) (TranscriptionAudioPlan, error) {
	if !filepath.IsAbs(inputPath) || !filepath.IsAbs(outputPath) || filepath.Clean(inputPath) == filepath.Clean(outputPath) || sourceStartMillis < 0 || durationMillis <= 0 || durationMillis > TranscriptionChunkMaximumMillis {
		return TranscriptionAudioPlan{}, errors.New("transcription audio input, output, or interval is invalid")
	}
	args := []string{
		"ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error",
		"-i", inputPath,
		"-ss", formatFFmpegMilliseconds(sourceStartMillis),
		"-t", formatFFmpegMilliseconds(durationMillis),
		"-map", "0:a:0", "-vn", "-map_metadata", "-1",
		"-c:a", "flac", "-compression_level", "8", "-ar", "16000", "-ac", "1",
		outputPath,
	}
	return TranscriptionAudioPlan{
		InputPath: inputPath, OutputPath: outputPath, SourceStartMs: sourceStartMillis, DurationMs: durationMillis,
		Codec: "flac", SampleRateHz: 16_000, Channels: 1, Command: args,
	}, nil
}

func RenderTranscriptionAudio(ctx context.Context, runner CommandRunner, plan TranscriptionAudioPlan) (MediaFacts, error) {
	if runner == nil || len(plan.Command) < 2 || plan.Command[0] != "ffmpeg" || plan.Codec != "flac" || plan.SampleRateHz != 16_000 || plan.Channels != 1 || plan.DurationMs <= 0 {
		return MediaFacts{}, errors.New("transcription audio plan is invalid")
	}
	output, err := runner.Run(ctx, plan.Command[0], plan.Command[1:]...)
	if err != nil {
		return MediaFacts{}, fmt.Errorf("encode transcription audio: %w: %s", err, string(output))
	}
	return VerifyTranscriptionAudio(ctx, runner, plan.OutputPath, plan.DurationMs)
}

func VerifyTranscriptionAudio(ctx context.Context, runner CommandRunner, path string, expectedDurationMillis int64) (MediaFacts, error) {
	if runner == nil || !filepath.IsAbs(path) || expectedDurationMillis <= 0 || expectedDurationMillis > TranscriptionChunkMaximumMillis {
		return MediaFacts{}, errors.New("transcription audio verification input is invalid")
	}
	output, err := runner.Run(ctx, "ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path)
	if err != nil {
		return MediaFacts{}, fmt.Errorf("ffprobe transcription audio: %w: %s", err, string(output))
	}
	facts, err := decodeMediaFacts(output)
	if err != nil {
		return MediaFacts{}, fmt.Errorf("decode transcription audio facts: %w", err)
	}
	if len(facts.Streams) != 1 || facts.Streams[0].CodecType != "audio" || facts.Streams[0].CodecName != "flac" || facts.Streams[0].SampleRate != "16000" || facts.Streams[0].Channels != 1 {
		return MediaFacts{}, errors.New("transcription audio is not mono FLAC at 16kHz")
	}
	duration, err := ParseDurationMs(facts.Format.Duration)
	if err != nil || absoluteInt64(duration-expectedDurationMillis) > 20 {
		return MediaFacts{}, fmt.Errorf("transcription audio duration %dms differs from expected %dms", duration, expectedDurationMillis)
	}
	return facts, nil
}

func formatFFmpegMilliseconds(value int64) string {
	seconds := value / 1000
	milliseconds := value % 1000
	return strconv.FormatInt(seconds, 10) + "." + fmt.Sprintf("%03d", milliseconds)
}
