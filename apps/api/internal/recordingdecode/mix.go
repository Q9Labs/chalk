package recordingdecode

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func writeMix(ctx context.Context, runner CommandRunner, ffmpegPath, workspace string, sources []Source, durationMS int64) (result Mix, resultErr error) {
	outputPath := filepath.Join(workspace, "mix.wav")
	samplesPerChannel := durationMS * 48
	microphones := make([]Source, 0)
	for _, source := range sources {
		if source.Kind == "microphone" {
			microphones = append(microphones, source)
		}
	}
	if len(microphones) == 0 || samplesPerChannel == 0 {
		if err := createSilentWAV(outputPath, 48_000, 2, samplesPerChannel); err != nil {
			return Mix{}, err
		}
	} else {
		pcmPath := filepath.Join(workspace, ".mix.pcm")
		defer func() {
			resultErr = errors.Join(resultErr, removeFileWithContext(pcmPath, "remove decoded mix PCM"))
		}()
		args := []string{"-hide_banner", "-nostdin", "-y", "-loglevel", "error"}
		var filter strings.Builder
		for index, source := range microphones {
			args = append(args, "-i", filepath.Join(workspace, filepath.FromSlash(source.Path)))
			filter.WriteString("[")
			filter.WriteString(strconv.Itoa(index))
			filter.WriteString(":a]pan=stereo|c0=c0|c1=c0,adelay=")
			filter.WriteString(strconv.FormatInt(source.StartMS*48, 10))
			filter.WriteString("S:all=1[a")
			filter.WriteString(strconv.Itoa(index))
			filter.WriteString("];")
		}
		for index := range microphones {
			filter.WriteString("[a")
			filter.WriteString(strconv.Itoa(index))
			filter.WriteString("]")
		}
		filter.WriteString("amix=inputs=")
		filter.WriteString(strconv.Itoa(len(microphones)))
		filter.WriteString(":duration=longest:normalize=0,apad,atrim=end_sample=")
		filter.WriteString(strconv.FormatInt(samplesPerChannel, 10))
		filter.WriteString(",aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo[out]")
		args = append(args, "-filter_complex", filter.String(), "-map", "[out]", "-c:a", "pcm_s16le", "-f", "s16le", pcmPath)
		if err := runFFmpeg(ctx, runner, ffmpegPath, args...); err != nil {
			return Mix{}, err
		}
		if err := createSilentWAV(outputPath, 48_000, 2, samplesPerChannel); err != nil {
			return Mix{}, err
		}
		output, err := os.OpenFile(outputPath, os.O_RDWR, 0)
		if err != nil {
			return Mix{}, fmt.Errorf("open mix WAV: %w", err)
		}
		copyErr := copyPCM(output, pcmPath, wavHeaderBytes, samplesPerChannel*4)
		syncErr := output.Sync()
		closeErr := output.Close()
		if copyErr != nil {
			return Mix{}, errors.Join(copyErr, syncErr, closeErr)
		}
		if err := errors.Join(syncErr, closeErr); err != nil {
			return Mix{}, fmt.Errorf("finalize mix WAV: %w", err)
		}
	}
	byteSize, checksum, err := fileFacts(outputPath)
	if err != nil {
		return Mix{}, fmt.Errorf("hash mix WAV: %w", err)
	}
	return Mix{
		Path: "mix.wav", Codec: "pcm_s16le", Container: "wav", ContentType: "audio/wav",
		SampleRateHz: 48_000, Channels: 2, ByteSize: byteSize, SHA256: checksum,
		StartMS: 0, EndMS: durationMS,
	}, nil
}
